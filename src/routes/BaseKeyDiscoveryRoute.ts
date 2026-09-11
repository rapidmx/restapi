///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The consuming application must apply `@Route("/.well-known/rapidmx/keys")` to its own concrete subclass
// (see `BaseMailIngestRoute`'s identical note) - `@Get("/:hash")` below then resolves to
// `GET /.well-known/rapidmx/keys/:hash`.
import * as crypto from "crypto";
import { ObjectDecorators } from "@rapidrest/core";
import { type HttpRequest, type HttpResponse, ObjectFactory, RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { EncryptionPreference, KeyVault, Mailbox, PublicKey } from "../models/types.js";
const { Config } = ObjectDecorators;
const { Get, Param, RateLimit, Request, Response } = RouteDecorators;

/** The all-defaults response served for a mailbox that either doesn't exist, or exists but has published
 * nothing - `specs/end-to-end_encryption.md` requires these to be byte-for-byte indistinguishable, since this
 * endpoint is otherwise a directory-harvesting oracle. Reuses `Mailbox.encryptPreference`/`Mailbox.keys`'s own
 * class-level defaults (`BaseMailboxRoute`), so a real mailbox that has simply never enrolled a key produces
 * this exact object with no special-casing - the "indistinguishable" property falls out of the data model
 * rather than needing to be maintained by hand here. */
const NOT_PUBLISHED_RESPONSE = {
    encryptPreference: { preferEncrypt: "nopreference" } as EncryptionPreference,
    keys: [] as PublicKey[],
    escrow: false,
};

/**
 * Implements `specs/end-to-end_encryption.md`'s public discovery endpoint
 * (`GET /.well-known/rapidmx/keys/:hash`, "Public Endpoint" section) - the server side of the protocol whose
 * client half is `util/KeyDiscoveryClient.ts`. Unauthenticated and `@RateLimit()`-decorated per the spec's
 * "rate-limit this endpoint per source IP" requirement (`@RateLimit()` already keys an independent per-source-
 * IP counter, confirmed in `BaseBookingRoute.ts` - no new infrastructure needed).
 *
 * `:hash` is looked up against `Mailbox.keyDiscoveryHash` (`C2`'s indexed column) - an indexed lookup, not a
 * per-request hash-everything scan. A mailbox that predates that column (never backfilled, see its own doc
 * comment) is simply not discoverable this way until it next saves with a `primarySmtpAddress`, the same
 * "resave to pick up a newly introduced derived field" limitation already accepted for `keyDiscoveryHash`
 * itself.
 *
 * `escrow` is computed from whether the mailbox's own `KeyVault` (fetched server-side with `ignoreACL: true` -
 * this route otherwise never reads `KeyVault` at all, and never returns anything from it) holds any
 * `MasterKeyWrap` with `method: "escrow"`. Full Escrow Scoping (named scopes, disclosure nuance beyond a
 * plain boolean) is its own deferred follow-up roadmap - this is only the boolean the spec's current "Public
 * Endpoint" section already requires, unaffected by that deferral.
 *
 * **Timing note, not glossed over**: the not-found and no-keys-published cases both pay the identical primary
 * cost (a `Mailbox` lookup by `keyDiscoveryHash`), which is the dominant cost and the one real implementations
 * of WKD-style endpoints actually control for. The found-mailbox path pays one additional `KeyVault` lookup
 * the not-found path skips (there is no `mailboxUid` to query by) - a real, if second-order, residual timing
 * differential this pass does not attempt to mask with artificial padding.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseKeyDiscoveryRoute<M extends Mailbox, K extends KeyVault> {
    protected abstract mailboxClass: any;
    protected abstract keyVaultClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private mailboxRepo?: RepoUtils<M>;
    private keyVaultRepo?: RepoUtils<K>;

    /** How long a requesting server may cache a response before revalidating - the spec requires this be set,
     * but leaves the duration to the deployment; per-user key freshness (not domain policy, see
     * `util/FederationUtils.ts`'s separate cache) is what this value actually governs. */
    @Config("mail:discovery:public_endpoint:max_age_seconds", 3600)
    private maxAgeSeconds: number = 3600;

    private async init(): Promise<void> {
        if (!this.mailboxRepo) {
            this.mailboxRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.mailboxClass.name,
                args: [this.mailboxClass],
            });
        }
        if (!this.keyVaultRepo) {
            this.keyVaultRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.keyVaultClass.name,
                args: [this.keyVaultClass],
            });
        }
    }

    private async buildResponse(mailbox: M | undefined): Promise<typeof NOT_PUBLISHED_RESPONSE> {
        if (!mailbox) {
            return NOT_PUBLISHED_RESPONSE;
        }
        const vaults: K[] = await this.keyVaultRepo!.find({ mailboxUid: mailbox.uid } as any, { ignoreACL: true, limit: 1 });
        const escrow: boolean = !!vaults[0]?.masterKeyWraps.some((w) => w.method === "escrow");
        return { encryptPreference: mailbox.encryptPreference, keys: mailbox.keys, escrow };
    }

    @RateLimit()
    @Get("/:hash")
    public async lookup(@Param("hash") hash: string, @Request req: HttpRequest, @Response res: HttpResponse): Promise<void> {
        await this.init();

        const matches: M[] = await this.mailboxRepo!.find({ keyDiscoveryHash: hash } as any, { ignoreACL: true, limit: 1 });
        const body = await this.buildResponse(matches[0]);

        const etag = `"${crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex")}"`;
        res.setHeader("etag", etag).setHeader("cache-control", `max-age=${this.maxAgeSeconds}`);

        const ifNoneMatch = req.headers["if-none-match"];
        if (ifNoneMatch === etag) {
            res.status(304).send();
            return;
        }
        res.status(200).json(body);
    }
}
