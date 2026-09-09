///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { ObjectDecorators } from "@rapidrest/core";
import { DkimKeyPair, DkimKeyProvider } from "./DkimKeyProvider.js";
const { Config, Logger } = ObjectDecorators;

/**
 * `DkimKeyProvider` that writes a plain 2048-bit RSA key pair directly to the local filesystem, at the
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
 * @author Jean-Philippe Steinmetz
 */
export class FsDkimKeyProvider implements DkimKeyProvider {
    @Config("mail:dkim:key_dir", "/var/lib/rspamd/dkim")
    private keyDir: string = "/var/lib/rspamd/dkim";

    @Config("mail:dkim:selector", "mail")
    private selector: string = "mail";

    @Logger
    private logger: any;

    private keyPath(domain: string): string {
        // `domain` is always a normalized `Domain.name` (see `BaseDomainRoute.assignUidAndCheckCollision()`
        // -> `normalizeAddress()`), never raw caller input, but guard the filename the same defense-in-depth
        // way `LocalFsBlobStore.resolvePath()` does for its own keys.
        const safeDomain: string = domain.toLowerCase().replace(/[\\/]/g, "_");
        const safeSelector: string = this.selector.replace(/[\\/]/g, "_");
        return path.join(this.keyDir, `${safeDomain}.${safeSelector}.key`);
    }

    private static publicKeyFromPrivate(privateKeyPem: string): string {
        const publicKey = crypto.createPublicKey(privateKeyPem);
        return publicKey.export({ type: "spki", format: "der" }).toString("base64");
    }

    public async ensureKeyPair(domain: string): Promise<DkimKeyPair> {
        const filePath: string = this.keyPath(domain);

        try {
            const existingPem: string = await fs.readFile(filePath, "utf-8");
            return { selector: this.selector, publicKey: FsDkimKeyProvider.publicKeyFromPrivate(existingPem) };
        } catch (err: any) {
            if (err.code !== "ENOENT") {
                throw err;
            }
        }

        const { privateKey } = crypto.generateKeyPairSync("rsa", {
            modulusLength: 2048,
            privateKeyEncoding: { type: "pkcs8", format: "pem" },
            publicKeyEncoding: { type: "spki", format: "pem" },
        });

        await fs.mkdir(this.keyDir, { recursive: true });
        // 0644, not 0600: this file is read by a different container's process (rspamd, a different Linux
        // user) over a shared volume, with no cross-container UID/GID coordination in place - see this
        // class's own doc comment. The directory itself should still be access-restricted at the volume/
        // host level in any deployment that cares about defense in depth beyond "not world-readable on the
        // host filesystem".
        await fs.writeFile(filePath, privateKey, { mode: 0o644 });
        this.logger?.info(`FsDkimKeyProvider: generated new DKIM key pair for domain '${domain}' (selector '${this.selector}').`);

        return { selector: this.selector, publicKey: FsDkimKeyProvider.publicKeyFromPrivate(privateKey) };
    }
}
