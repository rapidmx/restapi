///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, type JWTUser } from "@rapidrest/core";
import { ApiErrors, ModelUtils, type HttpRequest, type RepoUtils } from "@rapidrest/service-core";
import type { Mailbox } from "../models/types.js";
import { normalizeAddress } from "./AddressUtils.js";
import { normalizeUserUid } from "./UserUidUtils.js";

/**
 * Resolving a typed identifier - a mailbox address, an auth-server username or e-mail alias, or a user uid - to the
 * one real person it names, exact-match only, never fuzzy or partial. Originally private to `BaseMailboxAccessRoute`
 * (mailbox sharing's own "who is this?" lookup); lifted out here because the same problem - "an admin (or a mailbox
 * owner) must type SOMEONE's identity into a field, and the app must show them who that is before anything is saved,
 * without ever letting the field become a directory-browsing search" - recurs anywhere a person is assigned by
 * identifier rather than picked from an already-loaded list: mailbox sharing (`BaseMailboxAccessRoute`), mailbox
 * ownership (`BaseMailboxRoute`), escrow-scope holders (`BaseEscrowScopeRoute`), and any future one. Every one of
 * those call sites reuses `resolvePrincipal()` below rather than reimplementing it, so they can never drift from its
 * exact-match, no-directory-enumeration behaviour - the same reasoning `util/LocalKeyDiscoveryUtils.ts`'s
 * `discoverLocalKeys()` already established for local-key discovery shared across route classes.
 *
 * There is no separate `User`/identity directory anywhere in this platform (identity is issued entirely by an
 * external auth service this codebase never queries) - "who is this person" is answered entirely from a `Mailbox`
 * they own here, plus auth-server's own `GET /api/aliases` for a username/alias that hasn't (yet) got a mailbox.
 */

/** The person a principal resolves to. */
export interface ResolvedPrincipal {
    /** The user uid every grant is stored against (lowercase). */
    userUid: string;
    /** The person's display name and address when this server knows a mailbox they own - for a UI to confirm who it is. */
    displayName?: string;
    address?: string;
}

/**
 * What `resolvePrincipal()` needs from its caller: the concrete (Mongo/SQL) mailbox repo, that backend's own
 * alias-matching query shape (`BaseMailIngestRoute.aliasQueryValue()`'s Mongo/SQL split), and the auth-server/
 * self-service settings every mailbox-scoped route already reads off config. Same "local" dependency-injection shape
 * as `util/LocalKeyDiscoveryUtils.ts`'s `LocalKeyDiscovery` - lets this logic be shared across otherwise-unrelated
 * route classes without a common base class.
 */
export interface PrincipalResolutionContext {
    /** `RepoUtils<any>` (not `RepoUtils<Mailbox>`) so a caller's own, more specific `RepoUtils<M>` (`M extends
     * Mailbox`) can be passed directly - same convention as `util/LocalKeyDiscoveryUtils.ts`'s `LocalKeyDiscovery`. */
    mailboxRepo: RepoUtils<any>;
    /** The query value matching one element of `Mailbox.aliasAddresses` (`BaseMailIngestRoute.aliasQueryValue()`'s
     * Mongo/SQL split). */
    aliasQueryValue: (address: string) => any;
    /** Base URL of auth-server, whose `GET /api/aliases` resolves a username or e-mail alias to a user uid. Empty: none. */
    authServerUrl: string;
    /** The caller's own usernames when there is no auth-server at all (local development). */
    staticAliases: string[];
    authTimeoutMs: number;
}

/** One plain address: a single `@`, no whitespace, and nothing the search query syntax could read as an operator. */
export const PLAIN_ADDRESS_PATTERN = /^[^\s()@,]+@[^\s()@,]+$/;

/** The longest address worth looking up (RFC 5321's path limit). */
export const MAX_ADDRESS_LENGTH = 320;

/** The longest principal (address, username or uid) worth resolving. */
export const MAX_PRINCIPAL_LENGTH = MAX_ADDRESS_LENGTH;

/**
 * How many `resolve`/`lookup-by-email`-shaped requests one signed-in caller may make per `LOOKUP_WINDOW_SECONDS`.
 *
 * 30 a minute was sized for "add a member by hand" and nothing else, which made it the first limit a sharing screen
 * that resolves an address as it is typed (or re-resolves each existing member when it reloads) ran into; a screen
 * listing a dozen delegates could exhaust it by being opened three times. 300 a minute - 5 a second sustained -
 * leaves interactive use alone while still bounding every endpoint built on `resolvePrincipal()` as an
 * address-existence oracle. As with every explicit `@RateLimit()` limit in this library, a deployment's
 * `rateLimit.authenticated` tier does not raise it.
 */
export const LOOKUP_MAX_ATTEMPTS = 300;
export const LOOKUP_WINDOW_SECONDS = 60;

/** The message every "nobody resolves to this" answer uses, whatever status code the caller wraps it in - kept in
 * one place so a 400 (mid-grant) and a 404 (a bare resolve) never drift apart in wording. Never trims `principal`
 * itself - a mid-grant 400 (`BaseMailboxAccessRoute.setMember()`'s `noUserFound()`) shows exactly what was sent,
 * untrimmed; a bare resolve's 404 trims explicitly before calling this, matching `resolve()`'s pre-existing
 * behaviour. */
export function principalNotFoundMessage(principal: string): string {
    return `No user found for "${principal}".`;
}

/** A mailbox `uid` owns on this server (compared as stored and lowercased), if any. */
async function findOwnedMailbox(ctx: PrincipalResolutionContext, uid: string): Promise<Mailbox | undefined> {
    return (
        await ctx.mailboxRepo.find({ ownerUserUid: ModelUtils.literal([...new Set([uid, uid.toLowerCase()])], "in"), limit: 1 } as any, {
            ignoreACL: true,
            limit: 1,
        })
    )[0];
}

/** The mailbox with exactly this (lowercased plain) address as its uid, primary address or alias - exported so
 * `BaseMailboxAccessRoute.lookupOwnerByEmail()` (a related but distinct "who owns this address" lookup, not itself
 * part of resolving a typed principal) can share it rather than keep its own copy. */
export async function findMailboxByAddress(ctx: PrincipalResolutionContext, address: string): Promise<Mailbox | undefined> {
    const byUid: Mailbox | undefined = await ctx.mailboxRepo.findOne(address, { ignoreACL: true });
    const hasAddress = (candidate: Mailbox): boolean =>
        normalizeAddress(candidate.primarySmtpAddress) === address || candidate.aliasAddresses.some((alias) => normalizeAddress(alias) === address);
    return (
        (byUid && hasAddress(byUid) ? byUid : undefined) ??
        (await ctx.mailboxRepo.find({ primarySmtpAddress: ModelUtils.literal(address), limit: 1 } as any, { ignoreACL: true, limit: 1 }))[0] ??
        (await ctx.mailboxRepo.find({ aliasAddresses: ctx.aliasQueryValue(address), limit: 1 } as any, { ignoreACL: true, limit: 1 }))[0]
    );
}

/** `{ userUid, displayName?, address? }` for `uid`, from a mailbox they own here when there is one. */
async function describeUser(ctx: PrincipalResolutionContext, uid: string): Promise<ResolvedPrincipal> {
    const mailbox: Mailbox | undefined = await findOwnedMailbox(ctx, uid);
    return mailbox ? { userUid: uid, displayName: mailbox.displayName, address: mailbox.primarySmtpAddress } : { userUid: uid };
}

/** `GET <auth-server>/api/aliases?<query>` with the caller's own `jwt` cookie. Nothing when there is no auth-server or
 * cookie to ask with; 502 when it can't be reached. */
async function lookupAliases(
    ctx: PrincipalResolutionContext,
    query: string,
    req: HttpRequest | undefined,
): Promise<Array<{ alias?: string; userUid?: string; verified?: boolean }>> {
    const jwtCookie: string | undefined = req?.cookies?.["jwt"];
    if (!ctx.authServerUrl || !jwtCookie) {
        return [];
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ctx.authTimeoutMs);
    try {
        const response: Response = await fetch(`${ctx.authServerUrl}/api/aliases?${query}&limit=10`, {
            headers: { Cookie: `jwt=${jwtCookie}` },
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(`auth-server answered ${response.status}`);
        }
        const data: unknown = await response.json();
        return Array.isArray(data) ? data : [];
    } catch {
        throw new ApiError(ApiErrors.INTERNAL_ERROR, 502, "Could not reach the identity service to look that user up.");
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Resolves what a caller typed to the user it names, or `undefined` - never guessing. In order:
 * (1) the caller's own uid, or one of their own usernames (`staticAliases`, for a deployment with no auth-server) is
 * the caller; (2) a user uid is itself, when this server knows the user (they own a mailbox here) or, for a caller
 * auth-server lets read other users' aliases (a trusted, elevated token), when auth-server has an alias for that
 * uid; (3) a mailbox address (primary, alias or uid) is that mailbox's owner (an ownerless mailbox names nobody);
 * (4) otherwise a username or e-mail alias is the user auth-server holds a verified alias of that name for
 * (`GET /api/aliases?alias=<x>` with the caller's own cookie: auth-server lists an ordinary caller only their own
 * aliases and a trusted, elevated one everybody's, so a user can name themselves and an administrator anyone).
 * Usernames are never stored: they can be released and claimed by someone else, which would silently move whatever
 * this was resolved for onto a different person later.
 */
export async function resolvePrincipal(
    ctx: PrincipalResolutionContext,
    principal: string,
    user: JWTUser | undefined,
    req: HttpRequest | undefined,
): Promise<ResolvedPrincipal | undefined> {
    const typed: string = principal.trim();
    if (typed.length === 0 || typed.length > MAX_PRINCIPAL_LENGTH) {
        return undefined;
    }
    const lower: string = typed.toLowerCase();
    if (user?.uid && (lower === user.uid.toLowerCase() || ctx.staticAliases.some((alias) => alias.toLowerCase() === lower))) {
        return describeUser(ctx, user.uid.toLowerCase());
    }
    const uid: string | undefined = normalizeUserUid(typed);
    if (uid !== undefined) {
        const known: boolean =
            !!(await findOwnedMailbox(ctx, uid)) ||
            (await lookupAliases(ctx, `userUid=${encodeURIComponent(uid)}`, req)).some((entry) => entry.userUid?.toLowerCase() === uid);
        return known ? await describeUser(ctx, uid) : undefined;
    }
    if (typed.includes("@")) {
        const mailbox: Mailbox | undefined = PLAIN_ADDRESS_PATTERN.test(lower) ? await findMailboxByAddress(ctx, lower) : undefined;
        if (mailbox?.ownerUserUid) {
            return { userUid: mailbox.ownerUserUid.toLowerCase(), displayName: mailbox.displayName, address: mailbox.primarySmtpAddress };
        }
    }
    const alias = (await lookupAliases(ctx, `alias=${encodeURIComponent(typed)}`, req)).find(
        (entry) => entry.alias?.toLowerCase() === lower && entry.verified !== false && normalizeUserUid(entry.userUid) !== undefined,
    );
    return alias ? await describeUser(ctx, alias.userUid!.toLowerCase()) : undefined;
}
