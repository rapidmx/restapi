///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/**
 * Verifies the projected ServiceAccount token the DNS controller presents on `/internal/dns` (`Authorization: Bearer <token>`, audience
 * `rapidmx-internal-dns`): its signature against the cluster's service-account issuer keys (fetched in-cluster from
 * `https://kubernetes.default.svc/openid/v1/jwks`), its issuer, audience and expiry. The server registers its implementation as
 * `"DnsControllerTokenVerifier"`; `BaseDnsDesiredStateRoute` then checks the subject it returns against `mail:dns:controller:subject`. Without one
 * registered, every call is refused.
 */
export interface DnsControllerTokenVerifier {
    /** Resolves to the verified token's subject (`system:serviceaccount:<namespace>:<name>`); rejects when the token isn't valid. */
    verify(token: string): Promise<{ subject: string }>;
}
