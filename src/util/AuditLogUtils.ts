///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { Event, EventUtils, type JWTUser, type ObjectFactory } from "@rapidrest/core";
import { HttpRequest, NetUtils, RepoUtils } from "@rapidrest/service-core";
import { AuditAction } from "../models/types.js";

/** The caller-identifying context every `recordAuditLog()` call needs - the same fields `ModelRoute`'s own
 * `recordEvent` path (`node_modules/@rapidrest/service-core/dist/lib/routes/ModelRoute.js`) reads off a
 * route's `options.config`/`options.req`/`options.user`, quoted directly from a calling route's own fields
 * rather than duplicated here. */
export interface AuditLogCallerContext {
    /** The route's own `this.config` (`ModelRoute.config`) - needed both for `EventUtils.record()`'s
     * `Event` construction and to resolve `trusted_proxies` for `NetUtils.getIPAddress()`. */
    config: any;
    req?: HttpRequest;
    user?: JWTUser;
    logger?: any;
}

/** One audited action - see `AuditAction`'s own doc comment (`models/types.ts`) for the exact scope this
 * covers. */
export interface AuditLogParams {
    action: AuditAction;
    targetType: string;
    targetUid: string;
    mailboxUid?: string;
    details?: Record<string, any>;
}

/** Caches one `RepoUtils` per concrete `AuditLogEntry` class (Mongo vs SQL) - shared across every calling
 * route rather than each maintaining its own lazy-repo field/getter (the `getFolderRepo()`-style pattern
 * duplicated elsewhere in this codebase), since the repo here is keyed only by which concrete class is in
 * play, never by which route instance is calling. */
const auditLogRepoCache = new WeakMap<any, Promise<RepoUtils<any>>>();

function getAuditLogRepo(objectFactory: ObjectFactory, auditLogClass: any): Promise<RepoUtils<any>> {
    let cached = auditLogRepoCache.get(auditLogClass);
    if (!cached) {
        // `newInstance()` is typed `T | Promise<T>` (it may resolve synchronously) - normalize to a Promise so
        // this cache's own type (and every awaiting caller) stays uniform regardless of which path it took.
        cached = Promise.resolve(objectFactory.newInstance(RepoUtils, { name: auditLogClass.name, args: [auditLogClass] }));
        auditLogRepoCache.set(auditLogClass, cached);
    }
    return cached;
}

/**
 * Records one `AuditLogEntry` - the durable, admin-queryable row a `BaseAuditLogRoute` caller actually
 * browses - and, alongside it, calls `EventUtils.record()` (`@rapidrest/core`'s telemetry pipe, already
 * wired into `ModelRoute`'s own `recordEvent` option for `create`, see that file's exact reference
 * pattern quoted on `AuditLogCallerContext`). `EventUtils.record()` is always safe to call directly - its
 * own body already swallows every failure (including "not initialized", the state this repo's own test
 * environment is in - `EventUtils.init()` is a downstream deployment's responsibility, not this
 * library's) behind an internal try/catch that only logs a warning, never throws.
 *
 * Best-effort on the persistence half too: a failure to write the `AuditLogEntry` row is logged, never
 * propagated - an audit-logging failure must never block the admin action that was already committed.
 */
export async function recordAuditLog(
    objectFactory: ObjectFactory,
    auditLogClass: any,
    caller: AuditLogCallerContext,
    params: AuditLogParams,
): Promise<void> {
    const ip = caller.req ? NetUtils.getIPAddress(caller.req, caller.config?.get("trusted_proxies")) : undefined;

    try {
        const repo = await getAuditLogRepo(objectFactory, auditLogClass);
        await repo.create(new auditLogClass({ ...params, actorUserUid: caller.user?.uid, ip }), { ignoreACL: true });
    } catch (err: any) {
        caller.logger?.warn(`Failed to persist audit log entry (${params.action} ${params.targetType}:${params.targetUid}): ${err.message}`);
    }

    // Built as a separate variable (not an inline object literal at the `new Event()` call site) so TypeScript's
    // excess-property check against `NewEvent`'s narrow `{ type: string }` shape doesn't reject the extra
    // fields - `Event`'s own constructor happily copies any of them onto the instance regardless, matching
    // `ModelRoute.js`'s own reference call, quoted on this module's own doc comment above.
    const evt: any = { type: params.action, ...params, ip };
    void EventUtils.record(new Event(caller.config, caller.user?.uid ?? "anonymous", evt));
}
