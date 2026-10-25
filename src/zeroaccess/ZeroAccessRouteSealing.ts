///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError } from "@rapidrest/core";
import { ApiErrors, type ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import type { Mailbox, ZeroAccessDataType } from "../models/types.js";
import { hasSealedFields } from "./ZeroAccessFieldSealer.js";
import { newZeroAccessRecordSealer, type ZeroAccessRecordSealer } from "./ZeroAccessRecordSealer.js";

/**
 * What a REST route of calendar events, contacts or tasks does to seal the bodies it creates and updates (`specs/search.md` §3 *What It
 * Covers*): finds the record's mailbox and hands the body to the backend's `ZeroAccessRecordSealer`. Built by the route's `@Init` from its
 * backend's model classes; a backend without an `EncryptionPolicy` model seals nothing.
 */
export class ZeroAccessRouteSealing {
    private constructor(
        private readonly type: ZeroAccessDataType,
        private readonly mailboxRepo: RepoUtils<Mailbox> | undefined,
        private readonly sealer: ZeroAccessRecordSealer | undefined,
    ) {}

    /** The sealing of `type` records for a route whose backend has `mailboxClass` and `encryptionPolicyClass`. */
    public static async create(objectFactory: ObjectFactory, type: ZeroAccessDataType, mailboxClass: any, encryptionPolicyClass: any): Promise<ZeroAccessRouteSealing> {
        const mailboxRepo: RepoUtils<Mailbox> | undefined = mailboxClass
            ? await objectFactory.newInstance(RepoUtils, { name: mailboxClass.name, args: [mailboxClass] })
            : undefined;
        return new ZeroAccessRouteSealing(type, mailboxRepo, await newZeroAccessRecordSealer(objectFactory, encryptionPolicyClass));
    }

    /**
     * Seals (or stores readable) the protected fields of `obj`, a create (`existing` undefined) or update body, for the mailbox it will be
     * in - on a move to another mailbox, the destination, whose `mailboxUid` the route has already set on `obj`. The first protected write
     * of a record seals all of it, whatever the body carries (`sealFieldsOnWrite()`); a record moved to another mailbox is selected by the
     * backfill again (its `zeroAccessBackfillError` is cleared). A client's own `sealedFields` is never kept. A record with sealed content
     * can't move to another mailbox (409, `refuseSealedMove()`).
     *
     * An empty value (`null`, `[]`) of a sealed field is a clear only when the body names that field in `clearedFields` (`takeClearedFields()`):
     * a client that couldn't open the record sends back the empty placeholders it was shown, and those leave the sealed values alone.
     * `serverWrite`: `obj` was built by the server from what it was given in full (an invitation's revision), so every empty value is a clear.
     */
    public async seal(obj: any, existing: { mailboxUid?: string; sealedFields?: Record<string, string> | null } | undefined, serverWrite?: boolean): Promise<void> {
        const cleared: string[] = ZeroAccessRouteSealing.takeClearedFields(obj);
        ZeroAccessRouteSealing.refuseSealedMove(obj, existing);
        if (existing && obj.mailboxUid !== undefined && obj.mailboxUid !== existing.mailboxUid) {
            obj.zeroAccessBackfillError = null;
        }
        if (!this.sealer) {
            delete obj.sealedFields;
            return;
        }
        const mailboxUid: string | undefined = obj.mailboxUid ?? existing?.mailboxUid;
        const mailbox = mailboxUid ? await this.mailboxRepo?.findOne(mailboxUid, { ignoreACL: true }) : undefined;
        await this.sealer.sealWrite(this.type, mailbox, obj, existing, { emptyClears: serverWrite || cleared });
    }

    /**
     * Takes `clearedFields` off a create or update body (it is never stored) and returns it: the sealed fields the client empties on
     * purpose. A client sends it only for a field of a record it opened that held a value and that the user emptied - the proof that an
     * empty value is a clear rather than the placeholder a client that couldn't open the record was shown. Refused (400) unless it is a
     * list of field names.
     */
    public static takeClearedFields(obj: any): string[] {
        const cleared: unknown = obj.clearedFields;
        delete obj.clearedFields;
        if (cleared === undefined) {
            return [];
        }
        if (!Array.isArray(cleared) || cleared.length > 100 || !cleared.every((name) => typeof name === "string")) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "clearedFields must be a list of field names.");
        }
        return cleared;
    }

    /**
     * Refuses (409) moving a record whose content is sealed - field by field, as one blob (an event from a zero-access invitation) or its
     * photo - to another mailbox: what it keeps sealed is addressed to the mailbox it is in, the server can't seal it again to the
     * destination's key, and that mailbox's other members couldn't open it. The client copies it instead: it creates the record in the
     * destination with the content it opened, and deletes this one.
     */
    public static refuseSealedMove(obj: any, existing: Record<string, any> | undefined): void {
        if (!existing || obj.mailboxUid === undefined || obj.mailboxUid === existing.mailboxUid) {
            return;
        }
        if (hasSealedFields(existing) || existing.sealedContent || existing.photoSealed) {
            throw new ApiError(
                ApiErrors.INVALID_REQUEST,
                409,
                "This item's details are sealed to its mailbox's zero-access key, so it can't be moved to another mailbox. Copy it there instead.",
            );
        }
    }

    /** Whether `mailbox`'s mail is stored zero-access encrypted now - what its copy of a message carrying a secret must be filed as. */
    public async sealsMail(mailbox: Mailbox): Promise<boolean> {
        return !!(await this.sealer?.target("mail", mailbox));
    }

    /** The certificate `type` content of `mailboxUid` is sealed to now - for what a route keeps outside the record (a contact's photo
     * blob) - or `undefined` when it isn't protected. */
    public async certificateFor(mailboxUid: string): Promise<Uint8Array | undefined> {
        const mailbox = this.sealer ? await this.mailboxRepo?.findOne(mailboxUid, { ignoreACL: true }) : undefined;
        return mailbox ? (await this.sealer!.target(this.type, mailbox))?.certDer : undefined;
    }
}
