///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import {
    ApiErrorMessages,
    ApiErrors,
    CRUDRoute,
    HttpRequest,
    HttpResponse,
    RouteDecorators,
    type UpdateObject,
} from "@rapidrest/service-core";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { assertAdminScope, DEFAULT_ELEVATION_MAX_AGE_SECONDS } from "../util/MailAccessUtils.js";
import { isPlainAddress } from "../util/MimeHeaderUtils.js";
import { assertNoPathKeys, assertPlainPropertyName, stripClientCreateFields, stripClientId } from "../util/RequestBodyUtils.js";
import { AuditAction, TransportRule, TransportRuleActionType } from "../models/types.js";
const { Config } = ObjectDecorators;
const { Param, Query, Request, RequiresTrustedRole, Response, User: AuthUser } = RouteDecorators;

/** The most transport rules there can be: every inbound message is evaluated against all of them. */
export const MAX_TRANSPORT_RULES: number = 500;

/** The most actions one rule can have, entries one condition list can hold, and characters one condition string or header value can have. */
const MAX_RULE_ACTIONS = 20;
const MAX_CONDITION_ENTRIES = 100;
const MAX_CONDITION_LENGTH = 500;
const MAX_HEADER_VALUE_LENGTH = 998;

const CONDITION_LISTS: readonly string[] = ["fromContains", "subjectContains", "bodyContains", "recipientContains", "attachmentNameContains"];
const CONDITION_FLAGS: readonly string[] = ["anyRecipientExternal", "hasAttachment"];

/** `add_header` names that are a header's own to say (an `Authentication-Results` the MTA stamped, a signature, the routing trail) or that
 * define the message (who it is from, to, about): a rule can add a header, never forge or shadow these. Checked on the name in lowercase. */
const PROTECTED_HEADER_NAMES: ReadonlySet<string> = new Set([
    "authentication-results",
    "received",
    "received-spf",
    "dkim-signature",
    "return-path",
    "delivered-to",
    "rapidmx-key",
    "from",
    "sender",
    "reply-to",
    "to",
    "cc",
    "bcc",
    "subject",
    "date",
    "message-id",
    "mime-version",
    "in-reply-to",
    "references",
    "auto-submitted",
]);
const PROTECTED_HEADER_PREFIXES: readonly string[] = ["x-rapidmx-", "arc-", "content-", "resent-"];
const HEADER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

const invalid = (message: string): ApiError => new ApiError(ApiErrors.INVALID_REQUEST, 400, message);

/**
 * Refuses (400) a rule field that isn't what mail-flow evaluation (`util/TransportRuleUtils.ts`) expects: one rule it can't read would
 * otherwise fail every inbound message. With `complete` every field is required (a create); otherwise only the fields present in `rule`
 * are checked (an update is a patch).
 */
export function assertValidTransportRule(rule: Record<string, any>, complete: boolean): void {
    if ((complete || "name" in rule) && (typeof rule.name !== "string" || rule.name.trim().length === 0 || rule.name.length > MAX_CONDITION_LENGTH)) {
        throw invalid("A rule needs a name of at most 500 characters.");
    }
    for (const field of ["enabled", "stopProcessingRules"]) {
        if ((complete || field in rule) && typeof rule[field] !== "boolean") {
            throw invalid(`'${field}' must be true or false.`);
        }
    }
    if ((complete || "sequence" in rule) && !(Number.isSafeInteger(rule.sequence) && Math.abs(rule.sequence) <= 1_000_000)) {
        throw invalid("'sequence' must be a whole number.");
    }
    if (complete || "conditions" in rule) {
        assertValidConditions(rule.conditions);
    }
    if (complete || "actions" in rule) {
        const actions: unknown = rule.actions;
        if (!Array.isArray(actions) || actions.length > MAX_RULE_ACTIONS) {
            throw invalid(`'actions' must list at most ${MAX_RULE_ACTIONS} actions.`);
        }
        for (const action of actions) {
            assertValidAction(action);
        }
    }
}

function assertValidConditions(conditions: unknown): void {
    if (typeof conditions !== "object" || conditions === null || Array.isArray(conditions)) {
        throw invalid("'conditions' must be an object.");
    }
    for (const [key, value] of Object.entries(conditions)) {
        if (value === undefined || value === null) {
            continue;
        }
        if (CONDITION_FLAGS.includes(key)) {
            if (typeof value !== "boolean") {
                throw invalid(`'conditions.${key}' must be true or false.`);
            }
        } else if (CONDITION_LISTS.includes(key)) {
            if (
                !Array.isArray(value) ||
                value.length > MAX_CONDITION_ENTRIES ||
                value.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > MAX_CONDITION_LENGTH)
            ) {
                throw invalid(`'conditions.${key}' must be a list of at most ${MAX_CONDITION_ENTRIES} text values of 1 to ${MAX_CONDITION_LENGTH} characters.`);
            }
        } else {
            throw invalid(`'conditions.${key}' is not a condition.`);
        }
    }
}

function assertValidAction(action: any): void {
    if (typeof action !== "object" || action === null || Array.isArray(action)) {
        throw invalid("Every action must be an object.");
    }
    switch (action.type) {
        case TransportRuleActionType.REJECT:
        case TransportRuleActionType.QUARANTINE:
            return;
        case TransportRuleActionType.ADD_HEADER: {
            const name: unknown = action.headerName;
            if (typeof name !== "string" || !HEADER_NAME_PATTERN.test(name)) {
                throw invalid("An add_header action needs a 'headerName' made of letters, digits and hyphens.");
            }
            const lower: string = name.toLowerCase();
            if (PROTECTED_HEADER_NAMES.has(lower) || PROTECTED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
                throw invalid(`A rule can't add a '${name}' header.`);
            }
            if (typeof action.headerValue !== "string" || action.headerValue.length > MAX_HEADER_VALUE_LENGTH || CONTROL_CHARACTER.test(action.headerValue)) {
                throw invalid("An add_header action needs a 'headerValue' of one line of text.");
            }
            return;
        }
        case TransportRuleActionType.ADD_RECIPIENT:
            if (!isPlainAddress(action.recipientAddress)) {
                throw invalid("An add_recipient action needs a 'recipientAddress' that is one plain address.");
            }
            return;
        default:
            throw invalid("An action's 'type' must be one of: reject, quarantine, add_header, add_recipient.");
    }
}

/**
 * Extends the standard `CRUDRoute` CRUD scaffolding for `TransportRule` with trusted-role-only access to
 * every action - same admin-only pattern `BaseDistributionListRoute` already established (there is no
 * self-service creation, per-record delegated ownership, or real per-record ACL; the class ACL, like
 * `MailFilterRule`'s own, denies every action to everyone - see `TransportRuleMongo`/`SQL`'s `@Protect`
 * config). Simpler than `BaseDistributionListRoute`: a transport rule has no natural address, so there's no
 * uid-derivation or cross-entity collision check to perform on `create()`.
 *
 * Each method is decorated with `@RequiresTrustedRole()`, which installs a dispatch-time middleware
 * (`RouteUtils.checkTrusedRoles()`) that rejects a non-trusted caller with `403` before the handler body
 * ever runs. The handler bodies still bypass the framework's *default* ACL handling (calling
 * `this.repoUtils` directly with `ignoreACL: true`) rather than delegating to `super.*()`/`this.do*()`,
 * for the exact reason already documented on `BaseDistributionListRoute`: those helpers either
 * unconditionally deny via the (always-empty) class ACL, or never forward `ignoreACL` to the underlying
 * `RepoUtils` call at all.
 *
 * **A rule acts on every message of the server** - a header added, a copy of all mail sent to an address, mail refused or
 * quarantined - so creating, changing and deleting one needs an elevated administrator (`assertAdminScope()`), reading needs only the
 * trusted role. Every write is audited with what the rule does (and, for a change or delete, what it did). The bulk and per-property
 * endpoints `CRUDRoute` offers are routed through the same guarded `update()` (or refused: no bulk delete), and a rule's body is validated
 * on write (`assertValidTransportRule()`): a rule evaluation can't read would fail every inbound message, and `add_header` can't name a
 * header the MTA or the message itself owns (`Authentication-Results`, `From`, ...), which would forge sender verification.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseTransportRuleRoute<T extends TransportRule> extends CRUDRoute<T> {
    /** Supplied by the Mongo/SQL concrete subclasses so `recordAuditLog()` can persist an `AuditLogEntry`
     * without depending on either backend directly - see `util/AuditLogUtils.ts`. */
    protected abstract auditLogClass: any;
    /** How old an elevated token may be before it has to be elevated again, in seconds (`mail:security:elevation_max_age_seconds`, 0 = no limit). */
    @Config("mail:security:elevation_max_age_seconds", DEFAULT_ELEVATION_MAX_AGE_SECONDS)
    protected elevationMaxAgeSeconds: number = DEFAULT_ELEVATION_MAX_AGE_SECONDS;


    @RequiresTrustedRole()
    public async create(obj: T | T[], @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T | T[]> {
        assertAdminScope(user, this.trustedRoles, this.elevationMaxAgeSeconds);
        const singles: T[] = Array.isArray(obj) ? obj : [obj];
        for (const single of singles) {
            /* v8 ignore start -- the framework refuses a non-object body entry (400) before this runs; kept as a guard */
            if (typeof single !== "object" || single === null || Array.isArray(single)) {
                throw invalid("A rule must be an object.");
            }
            /* v8 ignore stop */
            // Always a server-minted uid, like every other create route (see `BaseScopedChildRoute`'s doc comment).
            delete (single as any).uid;
            // `_id` would replace another document on Mongo - see `util/RequestBodyUtils.ts`.
            stripClientCreateFields(single);
            assertValidTransportRule(single, true);
        }
        if ((await this.repoUtils!.count({} as any, { ignoreACL: true })) + singles.length > MAX_TRANSPORT_RULES) {
            throw invalid(`There can be at most ${MAX_TRANSPORT_RULES} transport rules.`);
        }
        const created: T[] = Array.isArray(obj)
            ? await this.doBulkCreate(obj, { req, user, ignoreACL: true })
            : [await this.doCreateObject(obj, { req, user, ignoreACL: true })];

        for (const rule of created) {
            await recordAuditLog(
                this._objectFactory!,
                this.auditLogClass,
                { config: this.config, req, user, logger: this.logger },
                {
                    action: AuditAction.TRANSPORT_RULE_CREATE,
                    targetType: "TransportRule",
                    targetUid: rule.uid,
                    // The actions are what the rule does to every message (an `add_recipient` copies all mail to an address): the entry names them.
                    details: { name: rule.name, enabled: rule.enabled, conditions: rule.conditions, actions: rule.actions },
                },
            );
        }

        return Array.isArray(obj) ? created : created[0];
    }

    /** `CRUDRoute`'s own `PUT /` goes straight to `doBulkUpdate()`: no validation, no audit entry, no elevation. Each entry goes through
     * the guarded `update()` instead; one failing entry aborts the rest. */
    @RequiresTrustedRole()
    public async updateBulk(objs: UpdateObject<T>[], @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T[]> {
        /* v8 ignore start -- the framework maps over the body before this runs, so a non-array body answers 500 first; kept as a guard */
        if (!Array.isArray(objs)) {
            throw invalid("An array of rules is expected.");
        }
        /* v8 ignore stop */
        assertAdminScope(user, this.trustedRoles, this.elevationMaxAgeSeconds);
        assertNoPathKeys(objs);
        const updated: T[] = [];
        for (const obj of objs) {
            updated.push(await this.update((obj as any)?.uid, obj, req, user));
        }
        return updated;
    }

    /** `CRUDRoute`'s own `PUT /:id/:property` writes any property with no validation and no audit entry: routed through `update()`. */
    @RequiresTrustedRole()
    public async updateProperty(
        @Param("id") id: string,
        @Param("property") propertyName: string,
        obj: any,
        @AuthUser user?: JWTUser,
    ): Promise<T> {
        assertPlainPropertyName(propertyName);
        assertAdminScope(user, this.trustedRoles, this.elevationMaxAgeSeconds);
        const existing: T | undefined = await this.repoUtils!.findOne(id, { ignoreACL: true });
        if (!existing) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        return await this.update(
            id,
            { uid: existing.uid, version: (existing as any).version, [propertyName]: obj } as any,
            undefined as unknown as HttpRequest,
            user,
        );
    }

    /** `CRUDRoute`'s own `DELETE /` would remove every rule matching a query with no audit entry: rules are deleted one at a time (`DELETE /:id`). */
    @RequiresTrustedRole()
    public async truncate(@Param() params: any, @Query() query: any, @AuthUser user?: JWTUser): Promise<void> {
        throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, "Transport rules must be deleted one at a time.");
    }

    @RequiresTrustedRole()
    public async update(
        @Param("id") id: string,
        obj: UpdateObject<T>,
        @Request req: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<T> {
        assertAdminScope(user, this.trustedRoles, this.elevationMaxAgeSeconds);
        assertNoPathKeys(obj);
        stripClientId(obj);
        const existing: T | undefined = await this.repoUtils!.findOne(id, { ignoreACL: true });
        if (!existing) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        assertValidTransportRule(obj as Record<string, any>, false);
        const updated: T = await this.repoUtils!.update(obj, existing, { user, version: (obj as any).version, ignoreACL: true });

        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, req, user, logger: this.logger },
            {
                action: AuditAction.TRANSPORT_RULE_UPDATE,
                targetType: "TransportRule",
                targetUid: updated.uid,
                // What the rule did before is part of the record: it can be changed to anything, and changed back.
                details: {
                    name: updated.name,
                    enabled: updated.enabled,
                    conditions: updated.conditions,
                    actions: updated.actions,
                    previous: { name: existing.name, enabled: existing.enabled, conditions: existing.conditions, actions: existing.actions },
                },
            },
        );

        return updated;
    }

    @RequiresTrustedRole()
    public async delete(
        @Param("id") id: string,
        @Query("version") version: string | undefined,
        @Query("purge") purge: string | undefined,
        @Request req: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<void> {
        assertAdminScope(user, this.trustedRoles, this.elevationMaxAgeSeconds);
        const existing: T | undefined = await this.repoUtils!.findOne(id, { version, ignoreACL: true });
        if (!existing) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        await this.repoUtils!.delete(existing.uid, { user, version, purge: purge === "true", ignoreACL: true });

        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, req, user, logger: this.logger },
            {
                action: AuditAction.TRANSPORT_RULE_DELETE,
                targetType: "TransportRule",
                targetUid: existing.uid,
                details: { name: existing.name, enabled: existing.enabled, conditions: existing.conditions, actions: existing.actions },
            },
        );
    }

    @RequiresTrustedRole()
    public async find(@Param() params: any, @Query() query: any, @AuthUser user?: JWTUser): Promise<T[]> {
        return await this.repoUtils!.find(
            { ...query, ...params },
            { limit: query?.limit, page: query?.page, version: query?.version, user, ignoreACL: true },
        );
    }

    @RequiresTrustedRole()
    public async count(
        @Param() params: any,
        @Query() query: any,
        @Response res: HttpResponse,
        @AuthUser user?: JWTUser,
    ): Promise<any> {
        const result: number = await this.repoUtils!.count(
            { ...query, ...params },
            { limit: query?.limit, page: query?.page, version: query?.version, user, ignoreACL: true },
        );
        return res.status(200).setHeader("content-length", result);
    }

    @RequiresTrustedRole()
    public async findById(@Param("id") id: string, @Query() query: any, @AuthUser user?: JWTUser): Promise<T | null> {
        const result: T | undefined = await this.repoUtils!.findOne(id, {
            version: query?.version,
            includeDeleted: query?.deleted === true || query?.deleted === "true",
            user,
            ignoreACL: true,
        });
        if (!result) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        return result;
    }
}
