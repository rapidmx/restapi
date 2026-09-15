///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    ACLAction,
    DocDecorators,
    ModelDecorators,
    PersistenceDecorators,
    RecoverableBaseMongoEntity,
} from "@rapidrest/service-core";
import { ObjectDecorators } from "@rapidrest/core";
import { Contact, ContactEmail, ContactPhone, ContactPostalAddress, EncryptionPreference, KeyConflict, PreviousKey, PublicKey, RejectedKey } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Nullable } = ObjectDecorators;
const { Column, Entity, Index } = PersistenceDecorators;

/**
 * Implementation of the `Contact` interface for storage in a MongoDB database. If SQL is desired, please use
 * `models.sql.ContactSQL` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("mongo")
@Entity()
@Description(
    "Defines a single address book entry. Contacts are also the source of truth for MAPI NSPI and EAS GAL " +
        "(Global Address List) lookups against a mailbox's own address book.",
)
@Index("contact_mailbox", ["mailboxUid"])
@Index("contact_folder", ["folderUid"])
@Index("contact_folder_modified", ["folderUid", "dateModified", "uid"])
@Index("contact_mailbox_modified", ["mailboxUid", "dateModified", "uid"])
@Protect(
    {
        uid: "Contact",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class ContactMongo extends RecoverableBaseMongoEntity implements Contact {
    @Column()
    @Description("The unique identifier of the `Mailbox` this contact belongs to.")
    public mailboxUid: string = "";

    @Column()
    @Description("The unique identifier of the `Folder` (of type `CONTACTS`) this contact resides in.")
    public folderUid: string = "";

    @Column()
    @Description("The unique identifier of the `ContactList` this contact is a member of, if any.")
    @Nullable
    public contactListUid?: string;

    @Column()
    @Description("The display name of the contact.")
    public displayName: string = "";

    @Column()
    @Description("The contact's given name (aka: first name).")
    @Nullable
    public givenName?: string;

    @Column()
    @Description("The contact's family surname (or last name).")
    @Nullable
    public surname?: string;

    @Column()
    @Description("The contact's email addresses.")
    public emails: ContactEmail[] = [];

    @Column()
    @Description("The contact's phone numbers.")
    public phones: ContactPhone[] = [];

    @Column()
    @Description("The contact's postal addresses.")
    public addresses: ContactPostalAddress[] = [];

    @Column()
    @Description("The name of the company the contact works for.")
    @Nullable
    public company?: string;

    @Column()
    @Description("The contact's job title.")
    @Nullable
    public jobTitle?: string;

    @Column()
    @Description("Free-form notes about the contact.")
    @Nullable
    public notes?: string;

    @Column()
    @Description("The key under which the contact's photo is stored in the `BlobStore`, if one has been set.")
    @Nullable
    public photoBlobKey?: string;

    @Column()
    @Description("The unique identifier of an external directory entry (e.g. GAL) this contact was sourced from, if any.")
    @Nullable
    public sourceUid?: string;

    @Column()
    @Description("Whether the caller has starred/favorited this contact.")
    @Nullable
    public favorite?: boolean;

    @Column()
    @Description("Free-form category labels (e.g. Outlook-style colored categories) applied to this contact, if any.")
    @Nullable
    public categories?: string[];

    @Column()
    @Description("This contact's known encryption preference, discovered via the federation protocol.")
    @Nullable
    public encryptPreference?: EncryptionPreference;

    @Column()
    @Description("The public keys this contact has published, as last observed via Discovery.")
    @Nullable
    public keys?: PublicKey[];

    @Column()
    @Description("UTC timestamp (epoch ms) at which this contact's keys were first observed (TOFU anchor).")
    @Nullable
    public keysFirstSeen?: number;

    @Column()
    @Description("UTC timestamp (epoch ms) of the most recent message observed from this contact.")
    @Nullable
    public lastMessageSeen?: number;

    @Column()
    @Description("Observed keys that conflict with the pinned key of their useType, at most one per useType.")
    @Nullable
    public keyConflicts?: KeyConflict[];

    @Column()
    @Description("Formerly pinned keys of this contact, newest first, at most 5 per useType.")
    @Nullable
    public previousKeys?: PreviousKey[];

    @Column()
    @Description("Observed keys the user rejected, newest first, at most 10.")
    @Nullable
    public rejectedKeys?: RejectedKey[];

    constructor(other?: Partial<ContactMongo>) {
        super(other);

        if (other) {
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.folderUid = other.folderUid !== undefined ? other.folderUid : this.folderUid;
            this.contactListUid = "contactListUid" in other ? other.contactListUid : this.contactListUid;
            this.displayName = other.displayName !== undefined ? other.displayName : this.displayName;
            this.givenName = "givenName" in other ? other.givenName : this.givenName;
            this.surname = "surname" in other ? other.surname : this.surname;
            this.emails = other.emails !== undefined ? other.emails : this.emails;
            this.phones = other.phones !== undefined ? other.phones : this.phones;
            this.addresses = other.addresses !== undefined ? other.addresses : this.addresses;
            this.company = "company" in other ? other.company : this.company;
            this.jobTitle = "jobTitle" in other ? other.jobTitle : this.jobTitle;
            this.notes = "notes" in other ? other.notes : this.notes;
            this.photoBlobKey = "photoBlobKey" in other ? other.photoBlobKey : this.photoBlobKey;
            this.sourceUid = "sourceUid" in other ? other.sourceUid : this.sourceUid;
            this.favorite = "favorite" in other ? other.favorite : this.favorite;
            this.categories = "categories" in other ? other.categories : this.categories;
            this.encryptPreference = "encryptPreference" in other ? other.encryptPreference : this.encryptPreference;
            this.keys = "keys" in other ? other.keys : this.keys;
            this.keysFirstSeen = "keysFirstSeen" in other ? other.keysFirstSeen : this.keysFirstSeen;
            this.lastMessageSeen = "lastMessageSeen" in other ? other.lastMessageSeen : this.lastMessageSeen;
            this.keyConflicts = "keyConflicts" in other ? other.keyConflicts : this.keyConflicts;
            this.previousKeys = "previousKeys" in other ? other.previousKeys : this.previousKeys;
            this.rejectedKeys = "rejectedKeys" in other ? other.rejectedKeys : this.rejectedKeys;
        }
    }
}
