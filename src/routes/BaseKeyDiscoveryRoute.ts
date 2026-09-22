///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The consuming application must apply `@Route("/.well-known/rapidmx/keys")` to its own concrete subclass
// (see `BaseMailIngestRoute`'s identical note) - `@Get("/:hash")` below then resolves to
// `GET /.well-known/rapidmx/keys/:hash`.
import * as crypto from "crypto";
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import { ApiErrors, type HttpRequest, type HttpResponse, ObjectFactory, RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { KeyDiscoveryResponse, KeyVault, Mailbox } from "../models/types.js";
import { isValidKeyDiscoveryHash } from "../util/KeyDiscoveryClient.js";
import { buildKeyDiscoveryResponse } from "../util/LocalKeyDiscoveryUtils.js";
const { Config } = ObjectDecorators;
const { Get, Param, Query, RateLimit, Request, Response } = RouteDecorators;

/**
 * Implements `specs/end-to-end_encryption.md`'s public discovery endpoint
 * (`GET /.well-known/rapidmx/keys/:hash`, "Public Endpoint" section) - the server side of the protocol whose
 * client half is `util/KeyDiscoveryClient.ts`. Unauthenticated and `@RateLimit()`-decorated per the spec's
 * "rate-limit this endpoint per source IP" requirement (`@RateLimit()` already keys an independent per-source-
 * IP counter - no new infrastructure needed).
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
 * **One builder.** The response body is `buildKeyDiscoveryResponse()` (`util/LocalKeyDiscoveryUtils.ts`), which
 * `GET /mailbox/:id/keys/lookup` also uses for a recipient that lives on this deployment, so what a remote peer is served and
 * what a local caller discovers can never drift.
 *
 * **Timing.** `buildKeyDiscoveryResponse()` always performs exactly one `KeyVault` lookup, even when no mailbox was found
 * (using a `mailboxUid` no real mailbox can ever have) - so the not-found and no-keys-published cases pay the
 * identical number/shape of DB round trips, closing the timing side channel an attacker could otherwise use
 * to test candidate addresses against this "indistinguishable" endpoint (the spec calls this out explicitly:
 * hashing the local part alone does not stop candidate testing, only raises its cost).
 *
 * **Domain scoping.** `keyDiscoveryHash` hashes the local part only (WKD-style), so it is not, on its own,
 * unique on a multi-domain deployment (`ceo@acme.com` / `ceo@contoso.com`). The requesting server names the
 * address's domain explicitly via the `?domain=<domain>` query parameter (`util/KeyDiscoveryClient.ts` always
 * sends it) - necessary because the request's `Host` is the discovery server's own hostname from the peer's
 * `_rapidmx` TXT record (e.g. `mail.acme.com`), which on a shared multi-domain server names neither domain.
 * For an older client that omits `domain`, the `Host` header (port stripped, lowercased) is used instead, the
 * previous behavior. `lookup()` fetches every mailbox matching the hash and picks the one whose
 * `primarySmtpAddress` domain matches, never an arbitrary first match.
 *
 * **Input validation.** `:hash` must be exactly 52 z-base32 characters (`computeKeyDiscoveryHash()`'s output
 * shape) or the request is rejected with `400` - a syntactic check on a value no real address can fail, so it
 * reveals nothing about which mailboxes exist - and it is queried as `eq(<hash>)`, the query DSL's literal
 * escape, so the value is never interpreted as a search operator.
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

    /** The domain to scope the lookup to: the `domain` query parameter when present (lowercased), otherwise
     * the `Host` header with any `:port` suffix stripped, lowercased - `req.headers.host` on an HTTP/1.1
     * request, or the `:authority` pseudo-header's value as `HttpRequest` normalizes it for HTTP/2. A repeated
     * `domain` parameter (an array) is not a valid request and matches nothing. */
    private requestedDomain(domainParam: unknown, req: HttpRequest): string {
        if (domainParam !== undefined && domainParam !== null && domainParam !== "") {
            return typeof domainParam === "string" ? domainParam.toLowerCase() : "";
        }
        return (req.headers["host"] ?? "").toString().split(":")[0].toLowerCase();
    }

    @RateLimit()
    @Get("/:hash")
    public async lookup(
        @Param("hash") hash: string,
        @Query("domain") domainParam: string | undefined,
        @Request req: HttpRequest,
        @Response res: HttpResponse,
    ): Promise<void> {
        await this.init();

        if (!isValidKeyDiscoveryHash(hash)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The discovery hash is malformed.");
        }

        // `keyDiscoveryHash` hashes the local part only - not unique across domains on a multi-domain
        // deployment (see this class's own "Domain scoping" doc comment) - so every match is fetched and
        // narrowed to the one whose address domain matches the requested domain, rather than trusting
        // whichever row a bare `limit: 1` happens to return first. Bounded (not unbounded) since a hash
        // collision within one deployment should only ever be a handful of rows at most (one per hosted
        // domain) - `limit` is baked into the query as well as the options, since the SQL backend reads only
        // the former.
        const candidates: M[] = await this.mailboxRepo!.find({ keyDiscoveryHash: `eq(${hash})`, limit: 20 } as any, {
            ignoreACL: true,
            limit: 20,
        });
        const domain: string = this.requestedDomain(domainParam, req);
        const match: M | undefined = domain
            ? candidates.find((m) => m.primarySmtpAddress?.split("@")[1]?.toLowerCase() === domain)
            : undefined;
        const body: KeyDiscoveryResponse = await buildKeyDiscoveryResponse(this.keyVaultRepo!, match);

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
