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
 * **Timing.** `buildResponse()` always performs exactly one `KeyVault` lookup, even when no mailbox was found
 * (using a `mailboxUid` no real mailbox can ever have) - so the not-found and no-keys-published cases pay the
 * identical number/shape of DB round trips, closing the timing side channel an attacker could otherwise use
 * to test candidate addresses against this "indistinguishable" endpoint (the spec calls this out explicitly:
 * hashing the local part alone does not stop candidate testing, only raises its cost).
 *
 * **Domain scoping.** `keyDiscoveryHash` hashes the local part only (WKD-style) - the spec places the domain
 * in the request's `Host` header instead, specifically so a multi-domain deployment doesn't collide two
 * different mailboxes (`ceo@acme.com` / `ceo@contoso.com`) sharing the same local part onto the same lookup.
 * `keyDiscoveryHash` is therefore not, on its own, unique - `lookup()` fetches every mailbox matching the hash
 * and picks the one whose `primarySmtpAddress` domain matches `Host`, rather than trusting an arbitrary first
 * match (which would let a peer querying `mail.acme.com` be served `ceo@contoso.com`'s keys).
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
        // Always exactly one `KeyVault` lookup, found or not (see this class's own "Timing" doc comment) - a
        // mailbox `uid` is derived from a real address (`BaseMailboxRoute.create()`), so `""` can never
        // collide with a genuine one, and querying by it simply returns no rows.
        const vaults: K[] = await this.keyVaultRepo!.find({ mailboxUid: mailbox?.uid ?? "" } as any, {
            ignoreACL: true,
            limit: 1,
        });
        if (!mailbox) {
            return NOT_PUBLISHED_RESPONSE;
        }
        const escrow: boolean = !!vaults[0]?.masterKeyWraps.some((w) => w.method === "escrow");
        return { encryptPreference: mailbox.encryptPreference ?? NOT_PUBLISHED_RESPONSE.encryptPreference, keys: mailbox.keys ?? [], escrow };
    }

    /** Lowercases and strips any `:port` suffix from a `Host` header value - `req.headers.host` on an
     * HTTP/1.1 request, or the `:authority` pseudo-header's value as `HttpRequest` normalizes it for HTTP/2. */
    private hostDomain(req: HttpRequest): string {
        return (req.headers["host"] ?? "").toString().split(":")[0].toLowerCase();
    }

    @RateLimit()
    @Get("/:hash")
    public async lookup(@Param("hash") hash: string, @Request req: HttpRequest, @Response res: HttpResponse): Promise<void> {
        await this.init();

        // `keyDiscoveryHash` hashes the local part only - not unique across domains on a multi-domain
        // deployment (see this class's own "Domain scoping" doc comment) - so every match is fetched and
        // narrowed to the one whose address domain matches the requested `Host`, rather than trusting
        // whichever row a bare `limit: 1` happens to return first. Bounded (not unbounded) since a hash
        // collision within one deployment should only ever be a handful of rows at most - a large match count
        // would itself be a signal something is wrong, not a case worth paying for with an unbounded scan.
        const candidates: M[] = await this.mailboxRepo!.find({ keyDiscoveryHash: hash } as any, { ignoreACL: true, limit: 20 });
        const hostDomain: string = this.hostDomain(req);
        const match: M | undefined = candidates.find((m) => m.primarySmtpAddress?.split("@")[1]?.toLowerCase() === hostDomain);
        const body = await this.buildResponse(match);

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
