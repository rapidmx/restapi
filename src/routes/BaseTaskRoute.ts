///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import type { Task } from "../models/types.js";
import { queryNamesFields } from "../util/CalendarEventUtils.js";
import { TASK_PROTECTED_FIELDS } from "../zeroaccess/ZeroAccessRecordSealer.js";
import { ZeroAccessRouteSealing } from "../zeroaccess/ZeroAccessRouteSealing.js";
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

    protected sealing?: ZeroAccessRouteSealing;

    /** `ZeroAccessBackfillJob`'s own mark, never a client's. */
    protected readonly serverManagedFields: readonly string[] = ["zeroAccessBackfillError"];

    @Init
    protected async initTaskSealing(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        this.sealing ??= await ZeroAccessRouteSealing.create(this._objectFactory, "tasks", this.mailboxClass, this.encryptionPolicyClass);
    }

    protected async prepareCreate(obj: any, user: JWTUser | undefined): Promise<void> {
        await super.prepareCreate(obj, user);
        await this.sealing?.seal(obj, undefined);
    }

    protected async prepareUpdate(obj: any, existing: T, user: JWTUser | undefined): Promise<void> {
        await super.prepareUpdate(obj, existing, user);
        await this.sealing?.seal(obj, existing);
    }

    protected async assertQueryAllowed(query: any, scopeUid: string, effectiveUser: JWTUser | undefined): Promise<void> {
        await super.assertQueryAllowed(query, scopeUid, effectiveUser);
        if (queryNamesFields(query, PROTECTED_TASK_FIELD_NAMES)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "Tasks can't be filtered or sorted by their title or notes, which may be encrypted.");
        }
    }
}
