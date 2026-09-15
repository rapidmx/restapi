///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, type JWTUser } from "@rapidrest/core";
import { ApiErrors, type RepoUtils } from "@rapidrest/service-core";
import { Contact, ContactAddressKind, Folder, FolderType } from "../models/types.js";
import { asEntity } from "./EntityUtils.js";
import { findOrCreateWellKnownFolder } from "./FolderUtils.js";
import { isDuplicateKeyError } from "./RequestBodyUtils.js";
import { nameBasedUuid } from "./UuidUtils.js";

/** How many times `writeContactKeys()` re-reads and re-merges after losing a race before giving up with a 409. */
export const MAX_CONTACT_KEY_WRITE_ATTEMPTS = 3;

/**
 * The uid a server-created `Contact` for `address` in `mailboxUid` gets (key discovery, the inbound `RapidMX-Key` header
 * and `POST /:id/keys/trust`). Deterministic, so two of those writers creating a contact for the same address at the
 * same time collide on the uid instead of adding two contacts that each pin their own key; the loser re-reads the
 * winner and merges into it. The address is used exactly as given, matching the exact-address contact lookup.
 */
export function keyContactUid(mailboxUid: string, address: string): string {
    return nameBasedUuid(`contact-keys:${mailboxUid}:${address}`);
}

/** Where `writeContactKeys()` reads and writes the contact for one address. */
export interface ContactKeyWriteTarget<C extends Contact, F extends Folder> {
    contactRepo: RepoUtils<C>;
    folderRepo: RepoUtils<F>;
    contactClass: any;
    folderClass: any;
    mailboxUid: string;
    address: string;
    /** Reads the live contact for `address` in the mailbox, uncached (so a re-read after a lost race sees the winner). */
    findContact: () => Promise<C | undefined>;
    /** Runs after the Contacts folder is resolved and before a new contact is created in it (e.g. a permission check). */
    beforeCreate?: (folder: F) => Promise<void>;
    /** The caller the writes are attributed to. ACLs are not checked by the writes themselves. */
    user?: JWTUser;
}

/** The fields to write onto `existing` (or onto a new contact when `undefined`), or `undefined` to write nothing. */
export type ContactKeyMerge<C extends Contact> = (existing: C | undefined) => Promise<Partial<C> | undefined> | Partial<C> | undefined;

export interface ContactKeyWriteResult<C extends Contact> {
    /** The contact as written, or as read when nothing was written (`undefined` when there is none). */
    contact: C | undefined;
    /** Whether `merge` produced fields that were persisted. */
    written: boolean;
}

function isVersionConflict(err: any): boolean {
    return err?.status === 409 && err?.code === ApiErrors.INVALID_OBJECT_VERSION;
}

/** Creates the contact at `keyContactUid()`. When that uid is held by a soft-deleted contact (the user deleted a
 * server-created contact), a random uid is used instead; a live holder rethrows the duplicate-key error so
 * `writeContactKeys()` re-reads it. */
async function createKeyContact<C extends Contact, F extends Folder>(target: ContactKeyWriteTarget<C, F>, fields: Partial<C>): Promise<C> {
    // No `user`: a folder created with one grants that caller creator actions on it (`RepoUtils.create()`), which would
    // give a delegate whose lookup or trust happened to create the mailbox's Contacts folder lasting access to it, and
    // would satisfy `beforeCreate`'s CREATE check by construction. The folder inherits the mailbox's ACL instead.
    const folder: F = await findOrCreateWellKnownFolder(target.folderRepo, target.folderClass, target.mailboxUid, FolderType.CONTACTS);
    await target.beforeCreate?.(folder);
    const uid: string = keyContactUid(target.mailboxUid, target.address);
    const build = (withUid: boolean): C =>
        new target.contactClass({
            ...(withUid ? { uid } : {}),
            mailboxUid: target.mailboxUid,
            folderUid: folder.uid,
            displayName: target.address,
            emails: [{ address: target.address, type: ContactAddressKind.OTHER }],
            phones: [],
            addresses: [],
            ...fields,
        });
    try {
        return await target.contactRepo.create(build(true), { user: target.user, ignoreACL: true });
    } catch (err: any) {
        if (!isDuplicateKeyError(err) || (await target.contactRepo.findOne(uid, { skipCache: true, ignoreACL: true }))) {
            throw err;
        }
        return await target.contactRepo.create(build(false), { user: target.user, ignoreACL: true });
    }
}

/**
 * Reads the contact for `target.address`, asks `merge` what to write and persists it: a version-checked update of an
 * existing contact, or a create at `keyContactUid()` when there is none. Losing either race (a concurrent write bumped
 * the version, or a concurrent create took the uid) re-reads and re-merges, so a merge that pins a key only when none
 * is pinned yet sees the winner's key rather than adding a second one. After `MAX_CONTACT_KEY_WRITE_ATTEMPTS` lost
 * races it fails with 409.
 *
 * Residual: two writers that both fall back to a random uid (the deterministic one is held by a soft-deleted contact)
 * can still create two contacts.
 */
export async function writeContactKeys<C extends Contact, F extends Folder>(
    target: ContactKeyWriteTarget<C, F>,
    merge: ContactKeyMerge<C>,
): Promise<ContactKeyWriteResult<C>> {
    for (let attempt = 1; ; attempt++) {
        const found: C | undefined = await target.findContact();
        const existing: C | undefined = found ? asEntity(target.contactRepo, found) : undefined;
        const fields: Partial<C> | undefined = await merge(existing);
        if (!fields) {
            return { contact: existing, written: false };
        }
        try {
            if (existing) {
                const updated: C = await target.contactRepo.update(
                    { uid: existing.uid, version: existing.version, ...fields },
                    existing,
                    { user: target.user, ignoreACL: true },
                );
                return { contact: updated, written: true };
            }
            return { contact: await createKeyContact(target, fields), written: true };
        } catch (err: any) {
            if (!isVersionConflict(err) && !(existing === undefined && isDuplicateKeyError(err))) {
                throw err;
            }
            if (attempt >= MAX_CONTACT_KEY_WRITE_ATTEMPTS) {
                throw new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "The contact changed while its keys were being updated. Try again.");
            }
        }
    }
}
