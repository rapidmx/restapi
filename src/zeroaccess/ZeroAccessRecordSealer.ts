///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { ACLUtils, type ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import type { Mailbox, ZeroAccessDataType } from "../models/types.js";
import { PROTECTED_TEXT, type ProtectedField, sealFieldsOnWrite } from "./ZeroAccessFieldSealer.js";
import { type ZeroAccessMailbox, ZeroAccessResolver, type ZeroAccessTarget } from "./ZeroAccessResolver.js";
const { Config, Inject } = ObjectDecorators;

/** What a protected task's title shows while it is sealed. */
export const PROTECTED_TASK_TITLE = "Protected task";

/** A task's protected fields (`specs/search.md` §3 *What It Covers*): its title and notes. */
export const TASK_PROTECTED_FIELDS: readonly ProtectedField[] = [
    { name: "title", placeholder: () => PROTECTED_TASK_TITLE },
    { name: "body", placeholder: () => null },
];

/** What a protected calendar event's title shows while it is sealed. */
export const PROTECTED_EVENT_TITLE = "Protected event";

/** A calendar event's protected fields (`specs/search.md` §3 *What It Covers*): its title, location and description. Its times, people,
 * responses and busy status stay readable for free/busy, invitations and reminders. */
export const EVENT_PROTECTED_FIELDS: readonly ProtectedField[] = [
    { name: "title", placeholder: () => PROTECTED_EVENT_TITLE },
    { name: "location", placeholder: () => null },
    { name: "description", placeholder: () => null },
    { name: "descriptionHtml", placeholder: () => null },
];

/** What a protected contact's name shows when it has no email address to show instead. */
export const PROTECTED_CONTACT_NAME = "Protected contact";

/**
 * A contact's protected fields (`specs/search.md` §3 *What It Covers*): everything but its email addresses, which the server needs to
 * deliver mail and to find the contact's encryption keys. The name shows the first address; the email list is sealed whole (its labels
 * are protected) and its readable copy keeps every address, labelled "other".
 */
export const CONTACT_PROTECTED_FIELDS: readonly ProtectedField[] = [
    { name: "displayName", placeholder: (contact) => contact.emails?.[0]?.address || PROTECTED_CONTACT_NAME },
    { name: "givenName", placeholder: () => null },
    { name: "surname", placeholder: () => null },
    { name: "company", placeholder: () => null },
    { name: "jobTitle", placeholder: () => null },
    { name: "notes", placeholder: () => null },
    { name: "phones", placeholder: () => [] },
    { name: "addresses", placeholder: () => [] },
    { name: "categories", placeholder: () => [] },
    { name: "emails", placeholder: (contact) => (contact.emails ?? []).map((email: { address: string }) => ({ address: email.address, type: "other" })) },
];

/** The protected fields of each data type that is sealed field by field. Mail is sealed whole (`ZeroAccessWriter`). */
export const PROTECTED_FIELDS: Readonly<Partial<Record<ZeroAccessDataType, readonly ProtectedField[]>>> = {
    tasks: TASK_PROTECTED_FIELDS,
    contacts: CONTACT_PROTECTED_FIELDS,
    calendar: EVENT_PROTECTED_FIELDS,
};

/** Re-exported so writers outside restapi (activesync, mapi) reach the placeholder without importing the field sealer. */
export { PROTECTED_TEXT };

/**
 * Seals calendar events, contacts and tasks on every write, whoever writes them - REST routes, ActiveSync, Outlook (MAPI), plugins and the
 * server itself (`specs/search.md` §3 *What It Covers*): `sealWrite()` applies `sealFieldsOnWrite()` with the type's protected fields and
 * the mailbox's zero-access key when that type is protected for it. One per backend (`newZeroAccessRecordSealer()`).
 */
export class ZeroAccessRecordSealer {
    @Inject(ACLUtils)
    protected aclUtils?: ACLUtils;

    @Config("trusted_roles", ["admin"])
    protected trustedRoles: string[] = ["admin"];

    @Config("mail:zero_access:allowed", true)
    protected allowedDefault: boolean = true;

    constructor(protected readonly policyRepo: RepoUtils<any> | undefined) {}

    /**
     * Applies a create (`existing` undefined) or update `patch` of a `type` record of `mailbox` in place, sealing its protected fields when
     * `type` is protected for the mailbox and storing them readable otherwise - see `sealFieldsOnWrite()`. A type without protected fields
     * leaves the patch alone.
     */
    public async sealWrite(
        type: ZeroAccessDataType,
        mailbox: (Pick<Mailbox, "uid"> & ZeroAccessMailbox) | undefined,
        patch: Record<string, any>,
        existing?: Record<string, any>,
    ): Promise<void> {
        const fields: readonly ProtectedField[] | undefined = PROTECTED_FIELDS[type];
        if (!fields) {
            return;
        }
        await sealFieldsOnWrite(patch, existing, fields, mailbox ? await this.target(type, mailbox) : undefined);
    }

    /** What `type` content of `mailbox` is sealed to now - its active zero-access key - or `undefined` when that type isn't protected. */
    public target(type: ZeroAccessDataType, mailbox: Pick<Mailbox, "uid"> & ZeroAccessMailbox): Promise<ZeroAccessTarget | undefined> {
        return new ZeroAccessResolver(this.policyRepo, this.aclUtils, this.allowedDefault, this.trustedRoles).target(mailbox, type);
    }
}

/** The `ZeroAccessRecordSealer` of a backend, or `undefined` without its `EncryptionPolicy` model (nothing is sealed then). */
export async function newZeroAccessRecordSealer(objectFactory: ObjectFactory, encryptionPolicyClass: any): Promise<ZeroAccessRecordSealer | undefined> {
    if (!encryptionPolicyClass) {
        return undefined;
    }
    const policyRepo: RepoUtils<any> = await objectFactory.newInstance(RepoUtils, { name: encryptionPolicyClass.name, args: [encryptionPolicyClass] });
    return await objectFactory.newInstance(ZeroAccessRecordSealer, { name: `ZeroAccessRecordSealer:${encryptionPolicyClass.name}`, args: [policyRepo] });
}
