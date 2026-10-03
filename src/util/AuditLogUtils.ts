///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { Event, EventUtils, type JWTUser, ObjectDecorators } from "@rapidrest/core";
import { HttpRequest, RepoUtils } from "@rapidrest/service-core";
import { AuditAction, Mailbox } from "../models/types.js";
import { resolveClientIp, type TrustedProxies } from "./ClientIpUtils.js";
import { asEntity } from "./EntityUtils.js";

const { Config, Logger } = ObjectDecorators;

/**
 * `true` when `user` is reading `mailbox`'s content as someone other than its own owner - an admin
 * reaching in via a trusted-role grant, or a delegate reading mail shared with them. This is the one
 * signal that distinguishes "a compliance-relevant access to someone else's mail" from the ordinary,
 * unaudited case of a user reading their own inbox - see `AuditAction.MESSAGE_CONTENT_ACCESSED`'s/
 * `MAILBOX_ACCESSED`'s own doc comments for where this gates a new audit entry. An unauthenticated
 * caller never reaches this check in practice (the read itself would already have been denied by ACL),
 * but is still treated as "non-owner" defensively rather than assumed to be the owner.
 */
export function isNonOwnerAccess(mailbox: Mailbox, user: JWTUser | undefined): boolean {
    return !user || mailbox.ownerUserUid !== user.uid;
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

/** The caller-identifying context `AuditLogUtils.record()` needs - just what is specific to the one request being
 * audited; the config and logger the service itself already holds. */
export interface AuditLogCaller {
    req?: HttpRequest;
    user?: JWTUser;
}

/**
 * Records `AuditLogEntry` rows - the durable, admin-queryable row a `BaseAuditLogRoute` caller browses. Built once by the consuming route/job's
 * `@Init` hook through the `ObjectFactory` with the (already built) `AuditLogEntry` repository -
 * `await objectFactory.newInstance(AuditLogUtils, { name: AuditLogEntryClass.name, args: [auditLogRepo] })` - so
 * the factory injects the whole config (for `EventUtils.record()`'s `Event`), `trusted_proxies` and a logger.
 */
export class AuditLogUtils {
    @Config()
    protected config: any;

    @Config("trusted_proxies", [])
    protected trustedProxies: TrustedProxies = [];

    @Logger
    protected logger: any;

    constructor(protected readonly auditLogRepo: RepoUtils<any>) {}

    /**
     * Records one audited action: persists the `AuditLogEntry` row and, alongside it, calls `EventUtils.record()`
     * (`@rapidrest/core`'s telemetry pipe - safe to call even when uninitialised, it swallows its own failures). Never throws -
     * a failure to write the row is logged, never propagated, since an audit-logging failure must never block the
     * admin action that was already committed (and `EventUtils.record()` swallows its own failures).
     */
    public async record(params: AuditLogParams, caller: AuditLogCaller = {}): Promise<void> {
        const ip: string | undefined = caller.req ? resolveClientIp(caller.req, this.trustedProxies) : undefined;

        try {
            await this.auditLogRepo.create(asEntity(this.auditLogRepo, { ...params, actorUserUid: caller.user?.uid, ip }), { ignoreACL: true });
        } catch (err: any) {
            this.logger?.warn(`Failed to persist audit log entry (${params.action} ${params.targetType}:${params.targetUid}): ${err.message}`);
        }

        // Built as a separate variable (not an inline object literal at the `new Event()` call site) so TypeScript's
    // excess-property check against `NewEvent`'s narrow `{ type: string }` shape doesn't reject the extra fields -
    // `Event`'s own constructor copies any of them onto the instance regardless.
        const evt: any = { type: params.action, ...params, ip };
        void EventUtils.record(new Event(this.config, caller.user?.uid ?? "anonymous", evt));
    }
}
