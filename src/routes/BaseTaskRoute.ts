///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import { ApiErrors, RepoUtils } from "@rapidrest/service-core";
import type { Mailbox, Task } from "../models/types.js";
import { queryNamesFields } from "../util/CalendarEventUtils.js";
import { newZeroAccessRecordSealer, TASK_PROTECTED_FIELDS, ZeroAccessRecordSealer } from "../zeroaccess/ZeroAccessRecordSealer.js";
import { BaseScopedChildRoute } from "./BaseScopedChildRoute.js";
const { Init } = ObjectDecorators;

/** The task fields zero-access encryption may protect, which therefore can't be filtered or sorted by. */
const PROTECTED_TASK_FIELD_NAMES: readonly string[] = TASK_PROTECTED_FIELDS.map((field) => field.name);

/**
 * `/mail/tasks`: a mailbox's tasks, with zero-access encryption of their title and notes when the mailbox protects tasks (`specs/search.md`
 * §3 *What It Covers*) - sealed on every create and update (`ZeroAccessRecordSealer`), with a placeholder title the server and phones see.
 * Because a protected title is ciphertext to the server, no list may filter or sort by the title or notes; clients sort what they decrypt.
 */
export abstract class BaseTaskRoute<T extends Task> extends BaseScopedChildRoute<T> {
    protected abstract mailboxClass: any;
    protected abstract encryptionPolicyClass: any;

    protected mailboxRepo?: RepoUtils<Mailbox & { version: number }>;
    protected recordSealer?: ZeroAccessRecordSealer;

    @Init
    protected async initTaskSealing(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        if (!this.mailboxRepo && this.mailboxClass) {
            this.mailboxRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.mailboxClass.name, args: [this.mailboxClass] });
        }
        this.recordSealer ??= await newZeroAccessRecordSealer(this._objectFactory, this.encryptionPolicyClass);
    }

    protected async prepareCreate(obj: any, user: JWTUser | undefined): Promise<void> {
        await super.prepareCreate(obj, user);
        await this.seal(obj, undefined);
    }

    protected async prepareUpdate(obj: any, existing: T, user: JWTUser | undefined): Promise<void> {
        await super.prepareUpdate(obj, existing, user);
        await this.seal(obj, existing);
    }

    /** Seals (or stores readable) `obj`'s title and notes for its mailbox; a client's own `sealedFields` is never kept. */
    private async seal(obj: any, existing: T | undefined): Promise<void> {
        if (!this.recordSealer) {
            delete obj.sealedFields;
            return;
        }
        const mailboxUid: string | undefined = existing?.mailboxUid ?? obj.mailboxUid;
        const mailbox = mailboxUid ? await this.mailboxRepo?.findOne(mailboxUid, { ignoreACL: true }) : undefined;
        await this.recordSealer.sealWrite("tasks", mailbox, obj, existing);
    }

    protected async assertQueryAllowed(query: any, scopeUid: string, effectiveUser: JWTUser | undefined): Promise<void> {
        await super.assertQueryAllowed(query, scopeUid, effectiveUser);
        if (queryNamesFields(query, PROTECTED_TASK_FIELD_NAMES)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "Tasks can't be filtered or sorted by their title or notes, which may be encrypted.");
        }
    }
}
