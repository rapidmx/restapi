///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, type JWTUser } from "@rapidrest/core";
import { ApiErrors, RepoUtils } from "@rapidrest/service-core";
import { getMailboxUidForFolder } from "../util/FolderUtils.js";
import { normalizeFilterSenderList } from "../util/SenderListUtils.js";
import { Label, MailFilterRule } from "../models/types.js";
import { BaseScopedChildRoute } from "./BaseScopedChildRoute.js";

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
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseMailFilterRuleRoute<T extends MailFilterRule> extends BaseScopedChildRoute<T> {
    protected readonly scopeProperty: string = "mailboxUid";

    /** The concrete `Folder` model class, supplied by the Mongo/SQL subclass. */
    protected abstract folderClass: any;

    /** The concrete `Label` model class, supplied by the Mongo/SQL subclass. */
    protected abstract labelClass: any;

    private labelRepo?: RepoUtils<Label>;

    private async assertActionTargetsInMailbox(actions: unknown, mailboxUid: string): Promise<void> {
        if (!Array.isArray(actions)) {
            return;
        }
        for (const action of actions) {
            const folderUid: unknown = action?.folderUid;
            if (folderUid !== undefined && folderUid !== null && folderUid !== "") {
                const owner: string | undefined =
                    typeof folderUid === "string" ? await getMailboxUidForFolder(this._objectFactory!, this.folderClass, folderUid) : undefined;
                if (owner !== mailboxUid) {
                    throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "A rule can only move or copy mail to a folder in its own mailbox.");
                }
            }
            const labelUid: unknown = action?.labelUid;
            if (labelUid !== undefined && labelUid !== null && labelUid !== "") {
                if (!this.labelRepo) {
                    this.labelRepo = await this._objectFactory!.newInstance(RepoUtils, {
                        name: this.labelClass.name,
                        args: [this.labelClass],
                    });
                }
                const label: Label | undefined =
                    typeof labelUid === "string" ? await this.labelRepo.findOne(labelUid, { ignoreACL: true }) : undefined;
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
