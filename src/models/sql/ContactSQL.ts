///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    ACLAction,
    DocDecorators,
    ModelDecorators,
    PersistenceDecorators,
    RecoverableBaseEntity,
} from "@rapidrest/service-core";
import { ObjectDecorators } from "@rapidrest/core";
import { Contact, ContactEmail, ContactPhone, ContactPostalAddress, EncryptionPreference, PublicKey } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Nullable } = ObjectDecorators;
const { Column, Entity, Index } = PersistenceDecorators;

/**
 * Implementation of the `Contact` interface for storage in a SQL database. If MongoDB is desired, please use
 * `models.mongo.ContactMongo` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@Description(
    "Defines a single address book entry. Contacts are also the source of truth for MAPI NSPI and EAS GAL " +
        "(Global Address List) lookups against a mailbox's own address book.",
)
@Index("contact_mailbox", ["mailboxUid"])
@Index("contact_folder", ["folderUid"])
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
export class ContactSQL extends RecoverableBaseEntity implements Contact {
    @Column()
    @Description("The unique identifier of the `Mailbox` this contact belongs to.")
    public mailboxUid: string = "";

    @Column()
    @Description("The unique identifier of the `Folder` (of type `CONTACTS`) this contact resides in.")
    public folderUid: string = "";

    @Column({ nullable: true })
    @Description("The unique identifier of the `ContactList` this contact is a member of, if any.")
    @Nullable
    public contactListUid?: string;

    @Column()
    @Description("The display name of the contact.")
    public displayName: string = "";

    @Column({ nullable: true })
    @Description("The contact's given name (aka: first name).")
    @Nullable
    public givenName?: string;

    @Column({ nullable: true })
    @Description("The contact's family surname (or last name).")
    @Nullable
    public surname?: string;

    @Column({ type: "simple-json" })
    @Description("The contact's email addresses.")
    public emails: ContactEmail[] = [];

    @Column({ type: "simple-json" })
    @Description("The contact's phone numbers.")
    public phones: ContactPhone[] = [];

    @Column({ type: "simple-json" })
    @Description("The contact's postal addresses.")
    public addresses: ContactPostalAddress[] = [];

    @Column({ nullable: true })
    @Description("The name of the company the contact works for.")
    @Nullable
    public company?: string;

    @Column({ nullable: true })
    @Description("The contact's job title.")
    @Nullable
    public jobTitle?: string;

    @Column({ nullable: true })
    @Description("Free-form notes about the contact.")
    @Nullable
    public notes?: string;

    @Column({ nullable: true })
    @Description("The key under which the contact's photo is stored in the `BlobStore`, if one has been set.")
    @Nullable
    public photoBlobKey?: string;

    @Column({ nullable: true })
    @Description("The unique identifier of an external directory entry (e.g. GAL) this contact was sourced from, if any.")
    @Nullable
    public sourceUid?: string;

    @Column({ nullable: true })
    @Description("Whether the caller has starred/favorited this contact.")
    @Nullable
    public favorite?: boolean;

    @Column({ type: "simple-json", nullable: true })
    @Description("Free-form category labels (e.g. Outlook-style colored categories) applied to this contact, if any.")
    @Nullable
    public categories?: string[];

    @Column({ type: "simple-json", nullable: true })
    @Description("This contact's known encryption preference, discovered via the federation protocol.")
    @Nullable
    public encryptPreference?: EncryptionPreference;

    @Column({ type: "simple-json", nullable: true })
    @Description("The public keys this contact has published, as last observed via Discovery.")
    @Nullable
    public keys?: PublicKey[];

    // `type: "double precision"`: without an explicit `type`, this framework's persistence layer resolves the column
    // type from TypeScript's own reflected design type (`Number`), which TypeORM maps to a 32-bit SQL
    // `integer`/`int` on Postgres/MySQL - max ~2.1 billion, while `Date.now()` (what this column actually
    // stores) is ~1.79 trillion and rising. Every inbound message from a sender already in this mailbox's
    // Contacts writes this value unguarded (`ScanQueueJob.persistContactKeyUpdate()`), so on Postgres this
    // throws "integer out of range" and the whole message fails to deliver - invisible in this repo's test
    // suite, which runs `better-sqlite3` only (a 64-bit `INTEGER` there regardless of declared width). `double
    // precision` (IEEE 754) exactly represents every integer up to 2^53 - millions of years of epoch-ms
    // headroom - and, unlike `bigint`, TypeORM hydrates it back as a real JS `number` rather than a `string`
    // (this framework's `@Column` has no `transformer` option to convert a `bigint` column's string result
    // back, so `bigint` is not actually usable here without one). Spelled `double precision` rather than `double`:
    // it's the one spelling TypeORM's Postgres, MySQL/MariaDB and SQLite drivers all accept (Postgres has no
    // `double` and refuses the entity at startup), and MySQL normalizes it to `double`, leaving a MySQL column
    // created as `double` untouched.
    @Column({ type: "double precision", nullable: true })
    @Description("UTC timestamp (epoch ms) at which this contact's keys were first observed (TOFU anchor).")
    @Nullable
    public keysFirstSeen?: number;

    @Column({ type: "double precision", nullable: true })
    @Description("UTC timestamp (epoch ms) of the most recent message observed from this contact.")
    @Nullable
    public lastMessageSeen?: number;

    @Column({ type: "simple-json", nullable: true })
    @Description("Set when an observed key conflicts with the currently pinned key for this contact.")
    @Nullable
    public keyConflict?: Contact["keyConflict"];

    constructor(other?: Partial<ContactSQL>) {
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
            this.keyConflict = "keyConflict" in other ? other.keyConflict : this.keyConflict;
        }
    }
}
