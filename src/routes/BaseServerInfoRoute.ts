///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The consuming application must apply `@Route("/.well-known/rapidmx/server-info")` to its own concrete subclass
// (see `BaseKeyDiscoveryRoute`'s identical note) - the one `@Get()` here is defined relative to that.
import { ObjectDecorators } from "@rapidrest/core";
import { RouteDecorators } from "@rapidrest/service-core";
const { Config } = ObjectDecorators;
const { Get, RateLimit } = RouteDecorators;

/** The wire shape of `GET /.well-known/rapidmx/server-info`. */
export interface ServerInfoResponse {
    /** This deployment's auth-server base URL - the same `mail:auth_server_url` setting `BaseMailboxRoute`,
     * `BaseMailboxAccessRoute`, `BaseEscrowScopeRoute` and `util/PrincipalResolutionUtils.ts` already read to call
     * auth-server's own `/api/aliases`, reused here rather than adding a second config key for the same value.
     * Empty when this deployment has no auth-server configured (local development, or an install not yet wired
     * up) - never omitted and this endpoint never answers `404`, so a caller can't use the field's absence, or the
     * endpoint's status code, to fingerprint which deployments are (mis)configured. */
    authServerUrl: string;
}

/**
 * Multi-server discovery's second hop. Each customer's RapidMX install deploys `server` and `auth-server` as two
 * independently reachable origins. A client - the native Tauri client is the first consumer - that has already
 * resolved an email domain to THIS server's own host (DNS `_rapidmx.<domain>` TXT record, see
 * `util/FederationUtils.ts`'s `resolveFederationPolicy()` and `specs/end-to-end_encryption.md`'s "Domain Lookup"
 * section) has no way to learn the separate auth-server host its sign-in flow needs - that gap is what this
 * endpoint closes. Once a client has this server's host, it fetches this well-known path from it and reads the
 * auth-server URL back, the same way `GET /.well-known/rapidmx/keys/:hash` is the second hop for key discovery.
 *
 * Unauthenticated (a client asks this before it holds any credential to authenticate with) and `@RateLimit()`-
 * decorated per source IP - the same posture as the sibling `.well-known` endpoint, `BaseKeyDiscoveryRoute`.
 *
 * Storage-agnostic: the value comes straight from config, never a model or a repository, so unlike
 * `BaseKeyDiscoveryRoute` this class takes no generic type parameter and needs no `init()`/`ObjectFactory`
 * plumbing - the same shape as `BaseSigningEnrollmentInfoRoute`. Its Mongo/SQL concrete subclasses exist only
 * because every route is registered per backend (see `KeyDiscoveryRouteSQL`/`Mongo`'s identical empty-body
 * subclasses); neither overrides anything here.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseServerInfoRoute {
    /** This deployment's auth-server base URL - see `ServerInfoResponse.authServerUrl`'s doc comment for why this
     * reuses that config key instead of adding a new one. Empty: none configured. */
    @Config("mail:auth_server_url", "")
    private authServerUrl: string = "";

    @RateLimit()
    @Get()
    public async get(): Promise<ServerInfoResponse> {
        return { authServerUrl: this.authServerUrl };
    }
}
