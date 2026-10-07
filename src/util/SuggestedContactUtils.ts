///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators, type JWTUser } from "@rapidrest/core";
import { ModelUtils, type RepoUtils } from "@rapidrest/service-core";
import { ContactAddressKind, FolderType } from "../models/types.js";
import { normalizeAddress } from "./AddressUtils.js";
import { CORRESPONDENT_BACKFILL_MAX_ADDRESSES } from "./CorrespondentUtils.js";
import { asEntity } from "./EntityUtils.js";
import { findOrCreateWellKnownFolder } from "./FolderUtils.js";
import { isDuplicateKeyError } from "./RequestBodyUtils.js";
import { nameBasedUuid } from "./UuidUtils.js";

const { Logger } = ObjectDecorators;

/** How many correspondents one `ensureSuggestedContacts()` call turns into contacts at most (each is a write, made one at a
 * time); the call reports how many are left so its caller can call again. */
export const SUGGESTED_CONTACTS_MAX_PER_CALL = CORRESPONDENT_BACKFILL_MAX_ADDRESSES;
/** How many existing contacts of a mailbox are read to find the addresses that already are someone's contact. */
export const SUGGESTED_CONTACTS_MAX_EXISTING = 10000;
/** How many contact folders of a mailbox are read. */
const MAX_CONTACT_FOLDERS = 200;
/** How often the marker write of one correspondent is retried after losing a race with a live recording of that address. */
const MAX_MARK_ATTEMPTS = 3;

/** What `ensureSuggestedContacts()` did. */
export interface SuggestedContactsResult {
    /** The uid of the mailbox's `SUGGESTED_CONTACTS` folder (created if it was missing). */
    folderUid: string;
    /** How many contacts were created in it by this call. */
    created: number;
    /** How many correspondents are still to be considered: call again until this is `0`. */
    remaining: number;
}

/** The deterministic uid of the suggested contact for `address` in `mailboxUid`, so two calls racing on the same mailbox
 * can never create two contacts for one address (the loser fails on the uid's unique index). */
export function suggestedContactUid(mailboxUid: string, address: string): string {
    return nameBasedUuid(`suggested-contact:${mailboxUid}:${normalizeAddress(address)}`);
}

/**
 * Turns the people a mailbox has exchanged mail or calendar invitations with (its `Correspondent` rows, see
 * `CorrespondentUtils`/`CorrespondentBackfillUtils`) into real `Contact`s in the mailbox's own "Suggested Contacts" folder
 * (`FolderType.SUGGESTED_CONTACTS`), a list of its own that never mixes with the user's normal contacts. Built once by the
 * consuming route's `@Init` hook through the `ObjectFactory` -
 * `await objectFactory.newInstance(SuggestedContactUtils, { name: CorrespondentClass.name, args: [correspondentRepo, folderRepo, contactRepo, folderClass, contactClass] })`
 * - with the already built repositories.
 *
 * Lazy: nothing happens until a caller asks (`POST /mail/directory/suggested-contacts`). Each correspondent is considered
 * once: `Correspondent.suggestedAt` is set whether a contact was made or the address already was one of the mailbox's
 * contacts, and a correspondent with it set is never considered again - so a suggested contact the user deleted, or moved to
 * their own contacts, never comes back.
 */
export class SuggestedContactUtils {
    @Logger
    protected logger: any;

    constructor(
        protected readonly correspondentRepo: RepoUtils<any>,
        protected readonly folderRepo: RepoUtils<any>,
        protected readonly contactRepo: RepoUtils<any>,
        protected readonly folderClass: any,
        protected readonly contactClass: any,
    ) {}

    /**
     * Creates the mailbox's `SUGGESTED_CONTACTS` folder if it has none, then a `Contact` in it for each correspondent of
     * `mailboxUid` not yet considered (at most `SUGGESTED_CONTACTS_MAX_PER_CALL` per call, most recently seen first) whose
     * address is not already an address of one of the mailbox's contacts - in any of its contacts folders, the suggested one
     * included (compared lowercased) - and marks every correspondent it considered. The contacts are written one at a time
     * (a single-connection SQL driver fails overlapping writes). A row that can't be written is logged and counted as
     * considered, never thrown, so one bad address can't hold up the rest or make a caller loop forever.
     *
     * **Access is the caller's to check first**: this writes into whichever mailbox it is given. `user` is only the creator
     * recorded on a new folder's ACL.
     */
    public async ensureSuggestedContacts(mailboxUid: string, user?: JWTUser): Promise<SuggestedContactsResult> {
        const folder = await findOrCreateWellKnownFolder(this.folderRepo, this.folderClass, mailboxUid, FolderType.SUGGESTED_CONTACTS, user);

        const unconsidered: any = { mailboxUid: ModelUtils.literal(mailboxUid), suggestedAt: null };
        const total: number = await this.correspondentRepo.count(unconsidered, { ignoreACL: true, skipCache: true });
        if (total === 0) {
            return { folderUid: folder.uid, created: 0, remaining: 0 };
        }
        const batch: any[] = await this.correspondentRepo.find(
            { ...unconsidered, sort: { lastSeenAt: "DESC", uid: "ASC" }, limit: SUGGESTED_CONTACTS_MAX_PER_CALL },
            { ignoreACL: true, limit: SUGGESTED_CONTACTS_MAX_PER_CALL, skipCache: true },
        );
        const known: Set<string> = await this.existingContactAddresses(mailboxUid);

        let created: number = 0;
        for (const correspondent of batch) {
            const address: string = normalizeAddress(String(correspondent.address ?? ""));
            if (address && !known.has(address)) {
                try {
                    if (await this.createContact(mailboxUid, folder.uid, address, correspondent.displayName)) {
                        created++;
                    }
                    known.add(address);
                } catch (err: any) {
                    this.logger?.warn(`SuggestedContactUtils: could not create a contact for ${address} in mailbox ${mailboxUid}: ${err?.message}`);
                }
            }
            await this.markConsidered(correspondent);
        }
        if (created > 0) {
            await this.bumpSyncKey(folder.uid);
        }
        return { folderUid: folder.uid, created, remaining: Math.max(0, total - batch.length) };
    }

    /** The lowercased addresses of the mailbox's contacts in every one of its contact folders. Bounded read. */
    protected async existingContactAddresses(mailboxUid: string): Promise<Set<string>> {
        const folders: any[] = await this.folderRepo.find(
            { mailboxUid: ModelUtils.literal(mailboxUid), type: [FolderType.CONTACTS, FolderType.SUGGESTED_CONTACTS], limit: MAX_CONTACT_FOLDERS } as any,
            { ignoreACL: true, limit: MAX_CONTACT_FOLDERS, skipCache: true },
        );
        const addresses = new Set<string>();
        if (folders.length === 0) {
            return addresses;
        }
        const contacts: any[] = await this.contactRepo.find(
            {
                mailboxUid: ModelUtils.literal(mailboxUid),
                folderUid: ModelUtils.literal(
                    folders.map((folder) => folder.uid),
                    "in",
                ),
                limit: SUGGESTED_CONTACTS_MAX_EXISTING,
            } as any,
            { ignoreACL: true, limit: SUGGESTED_CONTACTS_MAX_EXISTING, skipCache: true },
        );
        for (const contact of contacts) {
            for (const email of contact.emails ?? []) {
                if (typeof email?.address === "string") {
                    addresses.add(normalizeAddress(email.address));
                }
            }
        }
        return addresses;
    }

    /** Creates the contact for `address`. `false` when it already exists (another call created it first). */
    protected async createContact(mailboxUid: string, folderUid: string, address: string, displayName: unknown): Promise<boolean> {
        try {
            await this.contactRepo.create(
                new this.contactClass({
                    uid: suggestedContactUid(mailboxUid, address),
                    mailboxUid,
                    folderUid,
                    displayName: typeof displayName === "string" && displayName.trim() ? displayName.trim() : address,
                    emails: [{ address, type: ContactAddressKind.OTHER }],
                }),
                { ignoreACL: true },
            );
            return true;
        } catch (err: any) {
            if (isDuplicateKeyError(err) || err?.status === 409) {
                return false;
            }
            throw err;
        }
    }

    /** Sets `suggestedAt` on `correspondent` (re-reading the row if a live recording of the address changed it meanwhile).
     * Best-effort: a row that can't be marked is only considered again by the next call. */
    protected async markConsidered(correspondent: any): Promise<void> {
        let row: any = correspondent;
        for (let attempt = 1; row; attempt++) {
            try {
                await this.correspondentRepo.update({ uid: row.uid, version: row.version, suggestedAt: new Date() } as any, asEntity(this.correspondentRepo, row), {
                    ignoreACL: true,
                });
                return;
            } catch (err: any) {
                if (attempt >= MAX_MARK_ATTEMPTS) {
                    this.logger?.warn(`SuggestedContactUtils: could not mark ${correspondent.address} as considered: ${err?.message}`);
                    return;
                }
                row = await this.correspondentRepo.findOne(row.uid, { ignoreACL: true, skipCache: true });
            }
        }
    }

    /** Bumps the folder's `syncKeyVersion`, as every write that adds to a folder does, so a device that syncs it by that key
     * sees the new contacts. Best-effort. */
    protected async bumpSyncKey(folderUid: string): Promise<void> {
        for (let attempt = 1; attempt <= MAX_MARK_ATTEMPTS; attempt++) {
            try {
                const current: any = await this.folderRepo.findOne(folderUid, { ignoreACL: true, skipCache: true });
                if (!current) {
                    return;
                }
                await this.folderRepo.update({ uid: current.uid, version: current.version, syncKeyVersion: (current.syncKeyVersion ?? 0) + 1 } as any, asEntity(this.folderRepo, current), {
                    ignoreACL: true,
                    skipPush: true,
                });
                return;
            } catch (err: any) {
                if (attempt >= MAX_MARK_ATTEMPTS) {
                    this.logger?.warn(`SuggestedContactUtils: could not bump the sync key of folder ${folderUid}: ${err?.message}`);
                }
            }
        }
    }
}
