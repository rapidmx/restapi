///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { ObjectDecorators } from "@rapidrest/core";
import { createFileExclusive, readFileIfExists, writeFileAtomic } from "../pki/FileStoreUtils.js";
import { DkimKeyPair, DkimKeyProvider } from "./DkimKeyProvider.js";
const { Config, Logger } = ObjectDecorators;

/** A DKIM selector this provider accepts: one DNS label, in lowercase. */
const SELECTOR_PATTERN: RegExp = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** The size of a new RSA key, and the range `mail:dkim:rotation:key_bits` may set it in (RFC 8301: signers use at least 2048 bits). */
const DEFAULT_KEY_BITS = 2048;
const MIN_KEY_BITS = 2048;
const MAX_KEY_BITS = 4096;

/**
 * `DkimKeyProvider` that writes a plain RSA key pair (`mail:dkim:rotation:key_bits`, 2048 to 4096, 2048 by default) directly to the local filesystem, at the
 * exact path rspamd's `dkim_signing` module expects for its default (non-map-based) `path` template -
 * `<key_dir>/<domain>.<selector>.key` (see rspamd's own `dkim_signing.conf` documentation). A deployment
 * mounts the same directory into both this service (write) and the Postfix/rspamd container (read) as a
 * shared volume - see docker-compose.mail.yml's `dkim_rspamd_keys` volume.
 *
 * **Not verified against a live rspamd instance whether a key file written while rspamd is already
 * running is picked up on the very next signed message or needs a restart/reload** - rspamd's own
 * documentation doesn't say either way. `path`'s `$domain`/`$selector` substitution is evaluated
 * per-message rather than resolved once against a preloaded map, which suggests a fresh read rather than
 * a startup-cached one, but treat that as a reasonable expectation, not a confirmed guarantee - if mail
 * for a newly-added domain isn't coming out signed, restart the Postfix/rspamd container as a first step.
 *
 * **Rotation** (`DkimRotationJob`) keeps one key file per selector and two small files per domain next to them:
 *
 * - `<domain>.selector`: the selector to sign with, written atomically (temp file + rename) by `activate()`. Its absence means the global
 * `mail:dkim:selector`, so a deployment is unaffected until a domain's first rotation.
 * - `<domain>.signing`: written by postfix-bridge's `dkim-sync.sh` once OpenDKIM has reloaded with a selector, holding that selector;
 * `signingSelector()` reads it. This class never writes it.
 *
 * @author Jean-Philippe Steinmetz
 */
export class FsDkimKeyProvider implements DkimKeyProvider {
    public readonly supportsRotation: boolean = true;

    @Config("mail:dkim:key_dir", "/var/lib/rspamd/dkim")
    private keyDir: string = "/var/lib/rspamd/dkim";

    @Config("mail:dkim:selector", "mail")
    private selector: string = "mail";

    /** The RSA modulus length of a new key (`mail:dkim:rotation:key_bits`), checked by `modulusLength()`. */
    @Config("mail:dkim:rotation:key_bits", DEFAULT_KEY_BITS)
    private keyBits: number | string = DEFAULT_KEY_BITS;

    @Logger
    private logger: any;

    /** `<key_dir>/<domain>`, the start of every file of `domain`. `domain` is always a normalized `Domain.name` (see
     * `BaseDomainRoute.assignUidAndCheckCollision()` -> `normalizeAddress()`), never raw caller input, but the filename is guarded the same
     * defense-in-depth way `LocalFsBlobStore.resolvePath()` guards its own keys. */
    private domainFilePrefix(domain: string): string {
        return path.join(this.keyDir, domain.toLowerCase().replace(/[\\/]/g, "_"));
    }

    private keyPath(domain: string, selector: string): string {
        return `${this.domainFilePrefix(domain)}.${selector.replace(/[\\/]/g, "_")}.key`;
    }

    private static assertSelector(selector: string): void {
        if (typeof selector !== "string" || !SELECTOR_PATTERN.test(selector)) {
            throw new Error("A DKIM selector must be one DNS label in lowercase.");
        }
    }

    /** The selector the deployment's MTA signs `domain` with: `<domain>.selector` once a rotation has written one, else the global one. */
    private async activeSelector(domain: string): Promise<string> {
        const selector: string | undefined = (await readFileIfExists(`${this.domainFilePrefix(domain)}.selector`))?.trim();
        return selector && SELECTOR_PATTERN.test(selector) ? selector : this.selector;
    }

    /** `mail:dkim:rotation:key_bits` (a number or its text) when it is a whole number of bits from `MIN_KEY_BITS` to `MAX_KEY_BITS`, else
     * `DEFAULT_KEY_BITS` with a warning: a weaker key is rejected by many receivers, and a larger one no longer fits a DKIM TXT record well. */
    private modulusLength(): number {
        const bits: number = typeof this.keyBits === "string" ? Number(this.keyBits) : this.keyBits;
        if (Number.isInteger(bits) && bits >= MIN_KEY_BITS && bits <= MAX_KEY_BITS) {
            return bits;
        }
        this.logger?.warn(
            `FsDkimKeyProvider: mail:dkim:rotation:key_bits '${this.keyBits}' is not a whole number from ${MIN_KEY_BITS} to ${MAX_KEY_BITS}; ` +
                `using ${DEFAULT_KEY_BITS}.`,
        );
        return DEFAULT_KEY_BITS;
    }

    private static publicKeyFromPrivate(privateKeyPem: string): string {
        const publicKey = crypto.createPublicKey(privateKeyPem);
        return publicKey.export({ type: "spki", format: "der" }).toString("base64");
    }

    /** `selector`'s key, generated and persisted first when there is none yet. */
    private async readOrCreate(domain: string, selector: string): Promise<DkimKeyPair> {
        const filePath: string = this.keyPath(domain, selector);
        const existingPem: string | undefined = await readFileIfExists(filePath);
        if (existingPem !== undefined) {
            return { selector, publicKey: FsDkimKeyProvider.publicKeyFromPrivate(existingPem) };
        }

        // Generated on libuv's thread pool, never on the event loop: a 4096-bit key takes seconds, during which the server would answer nothing.
        const privateKey: string = await new Promise<string>((resolve, reject) =>
            crypto.generateKeyPair(
                "rsa",
                {
                    modulusLength: this.modulusLength(),
                    privateKeyEncoding: { type: "pkcs8", format: "pem" },
                    publicKeyEncoding: { type: "spki", format: "pem" },
                },
                (err: Error | null, _publicKey: string, generated: string) => (err ? reject(err) : resolve(generated)),
            ),
        );

        // 0644, not 0600: this file is read by a different container's process (rspamd, a different Linux
        // user) over a shared volume, with no cross-container UID/GID coordination in place - see this
        // class's own doc comment. The directory itself should still be access-restricted at the volume/
        // host level in any deployment that cares about defense in depth beyond "not world-readable on the
        // host filesystem". The directory is created 0755 for the same reason (rspamd must be able to traverse it).
        //
        // Written exclusively (temp file + atomic `link()`, never overwriting): two concurrent calls for the same
        // domain - in this process or another replica sharing the volume - each generate a key, but only the first
        // to land wins; the loser re-reads and returns the winner's key, so the published DNS record and the key
        // rspamd signs with can never diverge, and rspamd never reads a half-written file.
        const created: boolean = await createFileExclusive(filePath, privateKey, 0o644, 0o755);
        if (!created) {
            const winnerPem: string = await fs.readFile(filePath, "utf-8");
            return { selector, publicKey: FsDkimKeyProvider.publicKeyFromPrivate(winnerPem) };
        }
        this.logger?.info(`FsDkimKeyProvider: generated new DKIM key pair for domain '${domain}' (selector '${selector}').`);

        return { selector, publicKey: FsDkimKeyProvider.publicKeyFromPrivate(privateKey) };
    }

    /** The key of the selector `domain` is signed with: the global selector's until a rotation activates another. */
    public async ensureKeyPair(domain: string): Promise<DkimKeyPair> {
        return await this.readOrCreate(domain, await this.activeSelector(domain));
    }

    public async generateKeyPair(domain: string, selector: string): Promise<DkimKeyPair> {
        FsDkimKeyProvider.assertSelector(selector);
        return await this.readOrCreate(domain, selector);
    }

    public async findKeyPair(domain: string, selector: string): Promise<DkimKeyPair | undefined> {
        FsDkimKeyProvider.assertSelector(selector);
        const pem: string | undefined = await readFileIfExists(this.keyPath(domain, selector));
        return pem === undefined ? undefined : { selector, publicKey: FsDkimKeyProvider.publicKeyFromPrivate(pem) };
    }

    /** Writes `<domain>.selector` atomically, so postfix-bridge never reads a half-written one. Refuses a selector without a key, which the MTA
     * couldn't sign with. */
    public async activate(domain: string, selector: string): Promise<void> {
        if (!(await this.findKeyPair(domain, selector))) {
            throw new Error(`There is no DKIM key for selector '${selector}' of '${domain}' to sign with.`);
        }
        await writeFileAtomic(`${this.domainFilePrefix(domain)}.selector`, `${selector}\n`, 0o644, 0o755);
        this.logger?.info(`FsDkimKeyProvider: '${domain}' is now signed with selector '${selector}'.`);
    }

    public async signingSelector(domain: string): Promise<string | undefined> {
        const selector: string | undefined = (await readFileIfExists(`${this.domainFilePrefix(domain)}.signing`))?.trim();
        return selector && SELECTOR_PATTERN.test(selector) ? selector : undefined;
    }

    public async deleteKeyPair(domain: string, selector: string): Promise<void> {
        FsDkimKeyProvider.assertSelector(selector);
        if (selector === (await this.activeSelector(domain))) {
            throw new Error(`Selector '${selector}' of '${domain}' is the one it is signed with; its key is not deleted.`);
        }
        await fs.rm(this.keyPath(domain, selector), { force: true });
    }
}
