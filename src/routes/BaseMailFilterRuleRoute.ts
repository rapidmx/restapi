///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import { ApiErrors, HttpRequest, ModelUtils, RepoUtils, RouteDecorators, type UpdateObject } from "@rapidrest/service-core";
import { getMailboxUidForFolder } from "../util/FolderUtils.js";
import { isPlainAddress } from "../util/MimeHeaderUtils.js";
import { normalizeFilterSenderList } from "../util/SenderListUtils.js";
import { AuditAction, Folder, Label, MailFilterAction, MailFilterActionType, MailFilterRule } from "../models/types.js";
import { BaseScopedChildRoute } from "./BaseScopedChildRoute.js";
const { Init } = ObjectDecorators;
const { Request, User: AuthUser } = RouteDecorators;

/** The most actions one rule may carry: every `forward` action relays each matching message once more, from this server's domain. */
export const MAX_RULE_ACTIONS: number = 20;

/** The most rules one mailbox may have. */
export const MAX_RULES_PER_MAILBOX: number = 200;

/** The `AuditLogEntry.action` of a rule being created or changed. */
const RULE_AUDIT_CREATE: AuditAction = AuditAction.MAIL_FILTER_RULE_CREATE;
const RULE_AUDIT_UPDATE: AuditAction = AuditAction.MAIL_FILTER_RULE_UPDATE;

/**
 * `mailboxUid`-scoped CRUD for `MailFilterRule`, refusing (400) a rule whose action targets a `Folder` (`folderUid`) or
 * `Label` (`labelUid`) that doesn't exist or belongs to a different mailbox than the rule. Without that check, an owner
 * of one mailbox could write a rule that files their incoming mail into a folder of any mailbox whose folder uid they
 * know - the rule runs server-side, where no per-caller permission check applies. Checked whenever the actions or the
 * rule's mailbox change.
 *
 * The exact-match sender conditions are validated and normalized too (`validateSenderConditions()`): `conditions.fromEquals` must be
 * an array of at most 100 plain addresses and `conditions.fromDomainEquals` an array of at most 100 domains, each at most 254
 * characters - stored lowercase and de-duplicated (a domain without any leading `@`), anything else a 400. A `null` condition (what a
 * SQL row round-trips an absent one as) is dropped.
 *
 * A rule runs server-side on every message the mailbox receives, so its actions are bounded and checked: at most `MAX_RULE_ACTIONS`
 * per rule and `MAX_RULES_PER_MAILBOX` per mailbox (400), and a `forward` action needs a `forwardTo` that is one plain address (400). Creating or
 * changing a rule is audited (`mail_filter_rule.create`/`.update`) with the addresses it forwards to - a forward rule keeps relaying mail
 * after the delegate who wrote it is revoked.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseMailFilterRuleRoute<T extends MailFilterRule> extends BaseScopedChildRoute<T> {
    protected readonly scopeProperty: string = "mailboxUid";

    /** The concrete `Folder` model class, supplied by the Mongo/SQL subclass. */
    protected abstract folderClass: any;

    /** The concrete `Label` model class, supplied by the Mongo/SQL subclass. */
    protected abstract labelClass: any;

    protected labelRepo?: RepoUtils<Label>;
    protected folderRepo?: RepoUtils<Folder>;

    @Init
    protected async initMailFilterRuleRepos(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        if (!this.labelRepo && this.labelClass) {
            this.labelRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.labelClass.name, args: [this.labelClass] });
        }
        if (!this.folderRepo && this.folderClass) {
            this.folderRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.folderClass.name, args: [this.folderClass] });
        }
    }

    private async assertActionTargetsInMailbox(actions: unknown, mailboxUid: string): Promise<void> {
        if (!Array.isArray(actions)) {
            return;
        }
        if (actions.length > MAX_RULE_ACTIONS) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `A rule can have at most ${MAX_RULE_ACTIONS} actions.`);
        }
        for (const action of actions) {
            if (action?.type === MailFilterActionType.FORWARD && !isPlainAddress(action.forwardTo)) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "A forward action needs 'forwardTo' to be one plain email address.");
            }
            const folderUid: unknown = action?.folderUid;
            if (folderUid !== undefined && folderUid !== null && folderUid !== "") {
                const owner: string | undefined =
                    typeof folderUid === "string" ? await getMailboxUidForFolder(this.folderRepo!, folderUid) : undefined;
                if (owner !== mailboxUid) {
                    throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "A rule can only move or copy mail to a folder in its own mailbox.");
                }
            }
            const labelUid: unknown = action?.labelUid;
            if (labelUid !== undefined && labelUid !== null && labelUid !== "") {
                const label: Label | undefined =
                    typeof labelUid === "string" ? await this.labelRepo!.findOne(labelUid, { ignoreACL: true }) : undefined;
                if (label?.mailboxUid !== mailboxUid) {
                    throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "A rule can only apply a label from its own mailbox.");
                }
            }
        }
    }

    /** Validates and normalizes the exact-match sender conditions of `conditions` in place (see this class's doc comment). */
    private validateSenderConditions(conditions: unknown): void {
        if (typeof conditions !== "object" || conditions === null || Array.isArray(conditions)) {
            return;
        }
        const record: Record<string, unknown> = conditions as Record<string, unknown>;
        for (const [field, kind] of [
            ["fromEquals", "address"],
            ["fromDomainEquals", "domain"],
        ] as const) {
            if (record[field] === null) {
                delete record[field];
            } else if (record[field] !== undefined) {
                record[field] = normalizeFilterSenderList(record[field], field, kind);
            }
        }
    }

    protected async prepareCreate(obj: any, user: JWTUser | undefined): Promise<void> {
        await super.prepareCreate(obj, user);
        this.validateSenderConditions(obj.conditions);
        await this.assertActionTargetsInMailbox(obj.actions, obj.mailboxUid);
        if ((await this.repoUtils!.count({ mailboxUid: ModelUtils.literal(obj.mailboxUid) } as any, { ignoreACL: true })) >= MAX_RULES_PER_MAILBOX) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `A mailbox can have at most ${MAX_RULES_PER_MAILBOX} rules.`);
        }
    }

    /** Records `rule` being created or changed, naming the addresses it forwards to. */
    private async auditRule(action: AuditAction, rule: T, user: JWTUser | undefined, req: HttpRequest | undefined): Promise<void> {
        const forwardsTo: string[] = rule.actions
            .filter((entry: MailFilterAction) => entry.type === MailFilterActionType.FORWARD)
            .map((entry: MailFilterAction) => String(entry.forwardTo));
        await this.auditLogUtils!.record(
            {
                action,
                targetType: "MailFilterRule",
                targetUid: rule.uid,
                mailboxUid: rule.mailboxUid,
                details: { name: rule.name, enabled: rule.enabled, ...(forwardsTo.length > 0 ? { forwardsTo } : {}) },
            },
            { req, user },
        );
    }

    public async create(obj: T | T[], @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T | T[]> {
        // `prepareCreate()` counts what is stored, once per object and before any of a bulk request is created, so a bulk create is counted
        // as a whole here: the rules it adds to a mailbox on top of the ones that mailbox has can't pass the cap together.
        if (Array.isArray(obj) && obj.length > 1) {
            const adding: Map<string, number> = new Map();
            for (const rule of obj) {
                if (typeof rule?.mailboxUid === "string") {
                    adding.set(rule.mailboxUid, (adding.get(rule.mailboxUid) ?? 0) + 1);
                }
            }
            for (const [mailboxUid, count] of adding) {
                if ((await this.repoUtils!.count({ mailboxUid: ModelUtils.literal(mailboxUid) } as any, { ignoreACL: true })) + count > MAX_RULES_PER_MAILBOX) {
                    throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `A mailbox can have at most ${MAX_RULES_PER_MAILBOX} rules.`);
                }
            }
        }
        const created: T | T[] = await super.create(obj, req, user);
        for (const rule of Array.isArray(created) ? created : [created]) {
            await this.auditRule(RULE_AUDIT_CREATE, rule, user, req);
        }
        return created;
    }

    public async update(id: string, obj: UpdateObject<T>, @Request req?: HttpRequest, @AuthUser user?: JWTUser): Promise<T> {
        const updated: T = await super.update(id, obj, req, user);
        await this.auditRule(RULE_AUDIT_UPDATE, updated, user, req);
        return updated;
    }

    protected async prepareUpdate(obj: any, existing: T, user: JWTUser | undefined): Promise<void> {
        await super.prepareUpdate(obj, existing, user);
        this.validateSenderConditions(obj.conditions);
        const mailboxUid: string = obj.mailboxUid ?? existing.mailboxUid;
        if (obj.actions !== undefined || mailboxUid !== existing.mailboxUid) {
            await this.assertActionTargetsInMailbox(obj.actions ?? existing.actions, mailboxUid);
        }
    }
}
