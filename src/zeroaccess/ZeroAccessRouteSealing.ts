///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { type ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import type { Mailbox, ZeroAccessDataType } from "../models/types.js";
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

    /** Seals (or stores readable) the protected fields of `obj`, a create (`existing` undefined) or update body, for its mailbox. A client's
     * own `sealedFields` is never kept. */
    public async seal(obj: any, existing: { mailboxUid?: string } | undefined): Promise<void> {
        if (!this.sealer) {
            delete obj.sealedFields;
            return;
        }
        const mailboxUid: string | undefined = existing?.mailboxUid ?? obj.mailboxUid;
        const mailbox = mailboxUid ? await this.mailboxRepo?.findOne(mailboxUid, { ignoreACL: true }) : undefined;
        await this.sealer.sealWrite(this.type, mailbox, obj, existing);
    }

    /** The certificate `type` content of `mailboxUid` is sealed to now - for what a route keeps outside the record (a contact's photo
     * blob) - or `undefined` when it isn't protected. */
    public async certificateFor(mailboxUid: string): Promise<Uint8Array | undefined> {
        const mailbox = this.sealer ? await this.mailboxRepo?.findOne(mailboxUid, { ignoreACL: true }) : undefined;
        return mailbox ? (await this.sealer!.target(this.type, mailbox))?.certDer : undefined;
    }
}
