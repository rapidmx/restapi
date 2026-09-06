///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { BaseEntity, RecoverableBaseEntity } from "@rapidrest/service-core";

/**
 * The kind of well-known folder a `Folder` represents. `USER` is any folder created by the mailbox owner
 * (or a client) rather than one of the special system folders every mailbox is provisioned with.
 */
export enum FolderType {
    INBOX = "inbox",
    SENT_ITEMS = "sent_items",
    DRAFTS = "drafts",
    DELETED_ITEMS = "deleted_items",
    OUTBOX = "outbox",
    JUNK = "junk",
    CALENDAR = "calendar",
    CONTACTS = "contacts",
    TASKS = "tasks",
    NOTES = "notes",
    USER = "user",
}

/**
 * Defines a single mailbox belonging to a `User`. A mailbox is the root of a user's Folder hierarchy and the
 * unit that MAPI/EAS clients log on to.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface Mailbox extends BaseEntity {
    /**
     * The unique identifier of the `User` (from `@rapidrest/auth`) that owns this mailbox, if any. `undefined`
     * for a true shared mailbox (the Exchange "shared mailbox" concept, e.g. `support@example.com`) that has
     * no single owner — access to one of those is granted entirely via delegate `ACLRecord`s on the mailbox's
     * own `AccessControlList` instead. Creating an ownerless mailbox is a trusted-role-only action; a regular
     * self-service `create()` call always still makes the caller the owner. See `BaseMailboxRoute` for how
     * `find()`/`count()` resolve visibility (owned + shared + trusted-caller-sees-all) entirely from the ACL
     * system rather than from this field.
     */
    ownerUserUid?: string;

    /** The primary SMTP address that mail addressed to this mailbox is delivered under. */
    primarySmtpAddress: string;

    /** Additional SMTP addresses that also deliver to this mailbox. */
    aliasAddresses: string[];

    /** The display name shown to recipients (e.g. in the `From` header) for mail sent from this mailbox. */
    displayName: string;

    /** The IANA timezone identifier (e.g. `America/Los_Angeles`) used to render dates/times for this mailbox. */
    timezone: string;

    /** The maximum total size, in bytes, of all messages/attachments this mailbox may store. */
    quotaBytes: number;

    /** The current total size, in bytes, of all messages/attachments stored in this mailbox. */
    usedBytes: number;
}

/**
 * Defines a single folder within a `Mailbox`. Folders form a hierarchy via `parentFolderUid` and hold
 * `Message`, `CalendarEvent`, `Contact`, `Task`, or `Note` records depending on `type`.
 *
 * Extends `RecoverableBaseEntity` (soft delete, `deleted: boolean`) rather than plain `BaseEntity` so EAS
 * `FolderSync` can report a removed folder to an already-synced device — see `RecoverableRepoUtils` (in
 * `util/`) and `eas/EasSyncKeyUtils.ts` for the mechanism this backs.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface Folder extends RecoverableBaseEntity {
    /** The unique identifier of the `Mailbox` this folder belongs to. */
    mailboxUid: string;

    /** The display name of the folder. */
    name: string;

    /** The kind of well-known folder this is, or `USER` for an ordinary user-created folder. */
    type: FolderType;

    /** The unique identifier of the parent folder, or `undefined` if this is a top-level folder. */
    parentFolderUid?: string;

    /** The number of unread items contained directly in this folder. */
    unreadCount: number;

    /** The total number of items contained directly in this folder. */
    totalCount: number;

    /**
     * A monotonically increasing counter bumped on every change (add/change/delete of a contained item, or of
     * the folder itself) to this folder's contents. EAS `SyncKey` and MAPI ICS-style folder sync state are both
     * derived from this value.
     */
    syncKeyVersion: number;
}

/** The kind of address a `Recipient` represents on a `Message`. */
export enum RecipientType {
    TO = "to",
    CC = "cc",
    BCC = "bcc",
}

/** An embedded recipient (or sender) address on a `Message`. */
export interface Recipient {
    address: string;
    displayName?: string;
    type: RecipientType;
}

/** The read/answered/flagged state of a `Message`. */
export interface MessageFlags {
    read: boolean;
    flagged: boolean;
    answered: boolean;
    forwarded: boolean;
}

export enum MessageImportance {
    LOW = "low",
    NORMAL = "normal",
    HIGH = "high",
}

/**
 * Defines a single email message stored in a `Folder`. The raw MIME source and sanitized HTML body are not
 * stored inline on this record — they live in the configured `BlobStore`, referenced by
 * `bodyBlobKey`/`sanitizedHtmlBlobKey`.
 *
 * Extends `RecoverableBaseEntity` (soft delete, `deleted: boolean`) rather than plain `BaseEntity` — see the
 * identical note on `Folder`.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface Message extends RecoverableBaseEntity {
    /** The unique identifier of the `Folder` this message currently resides in. */
    folderUid: string;

    /**
     * The unique identifier of the `Mailbox` this message belongs to.
     *
     * ARCHITECTURE NOTE (the sharing model for this whole library): only two entities get a real per-record
     * `AccessControlList` (`@Protect(..., true)`) — `Mailbox` (the root) and `Folder` (whose ACL's `parentUid`
     * points at its owning mailbox's ACL, so a mailbox-wide grant flows down to every folder in it by default,
     * while a single folder — e.g. one Calendar — can still be shared independently on its own ACL, which is
     * what makes it possible to share just a calendar with someone without sharing the whole mailbox).
     *
     * Every other entity in this library is a "folder child" with no ACL of its own: `Message`,
     * `CalendarEvent`, `Task`, `Note`, `Contact`, `Attachment`, and `CalendarShareLink` all carry a denormalized
     * `folderUid` and are `@Protect(..., false)` — permissions on an individual message/event/etc. are never
     * granted or revoked independently of the folder it lives in, so giving each of them their own ACL document
     * would be both unnecessary (nothing ever differs per-record) and expensive at scale (one ACL document per
     * message vs. one per folder). `ContactList` has no folder to belong to and instead carries a denormalized
     * `mailboxUid`, checked directly against the mailbox's ACL. Every route for these folder/mailbox-scoped
     * entities checks `ACLUtils.hasPermission(user, record.folderUid | record.mailboxUid, action)` against the
     * owning folder's or mailbox's ACL (which `hasPermission` resolves by uid, following its own `parentUid`
     * chain), then performs the actual `RepoUtils` operation with `ignoreACL: true` since permission was
     * already established. See `BaseScopedChildRoute` for the shared implementation, and `BaseFolderRoute` for
     * `Folder`'s own hybrid pattern (real ACL, but `find`/`count`/`create` still need explicit mailbox-scoped
     * permission checks the same way, since a folder doesn't exist yet at create time and class-level `LIST` is
     * denied for privacy the same reason it is everywhere else in this library).
     *
     * `mailboxUid` itself remains on `Message` (redundant with its `Folder`'s own `mailboxUid`) purely as a
     * denormalized convenience for queries that scan a whole mailbox without caring about folder boundaries
     * (e.g. `MailboxQuotaRecalcJob`) — it plays no role in permission checks.
     */
    mailboxUid: string;

    /** The RFC 5322 `Message-ID` header value, used to deduplicate and thread messages. */
    messageId: string;

    subject: string;

    from: Recipient;

    recipients: Recipient[];

    sentDate: Date;

    receivedDate: Date;

    /** The key under which the raw MIME source is stored in the `BlobStore`, unmodified from ingestion/send. */
    bodyBlobKey: string;

    /**
     * The key under which the message's HTML body is stored, AFTER `ScanPipeline`'s sanitization pass has run
     * (script/active-content stripped) — set once scanning completes, absent for a not-yet-scanned draft or a
     * message with no HTML body at all. A renderer displaying message content should always prefer this over
     * re-deriving HTML from `bodyBlobKey`'s raw MIME directly, which is never sanitized.
     */
    sanitizedHtmlBlobKey?: string;

    /** A short plain-text preview of the message body, generated at ingestion time. */
    bodyPreview: string;

    flags: MessageFlags;

    importance: MessageImportance;

    /** The RFC 5322 `In-Reply-To` header value, if this message is a reply. */
    inReplyTo?: string;

    /** The RFC 5322 `References` header value(s), for building conversation threads. */
    references: string[];

    hasAttachments: boolean;

    /** The unique identifier of this message's `ScanResult`, once scanning has completed. */
    scanResultUid?: string;

    /** The timestamp this message was last (re)indexed for full-text search, if ever. */
    searchIndexedAt?: Date;
}

/**
 * Defines a single file attached to a `Message`. The binary content is stored in the configured `BlobStore`,
 * referenced by `blobKey`.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface Attachment extends BaseEntity {
    /** The unique identifier of the `Message` this attachment belongs to. */
    messageUid: string;

    /**
     * The unique identifier of the `Folder` the owning `Message` resides in. Denormalized from that `Message`
     * so permission checks (see the architecture note on `Message.mailboxUid`) don't require a lookup through
     * it first — an attachment is only ever readable by whoever can read its message, i.e. whoever has
     * permission on that message's folder.
     */
    folderUid: string;

    /** The unique identifier of the `Mailbox` this attachment belongs to. Denormalized purely for convenience
     * queries that scan a whole mailbox (e.g. `MailboxQuotaRecalcJob`); plays no role in permission checks. */
    mailboxUid: string;

    filename: string;

    mimeType: string;

    sizeBytes: number;

    /** The key under which the attachment's binary content is stored in the `BlobStore`. */
    blobKey: string;

    /** The MIME `Content-ID`, present when this attachment is referenced inline by the message's HTML body. */
    contentId?: string;

    /** `true` if this attachment is displayed inline in the message body rather than listed separately. */
    isInline: boolean;

    /** The key under which this attachment's extracted plain text is stored in the `BlobStore`, once extracted. */
    extractedTextBlobKey?: string;

    /** The unique identifier of this attachment's `ScanResult`, once scanning has completed. */
    scanResultUid?: string;
}

export enum ContactAddressKind {
    HOME = "home",
    WORK = "work",
    OTHER = "other",
}

export interface ContactEmail {
    address: string;
    type: ContactAddressKind;
}

export interface ContactPhone {
    phoneNumber: string;
    type: ContactAddressKind;
}

export interface ContactPostalAddress {
    street?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
    type: ContactAddressKind;
}

/**
 * Defines a single address book entry. Contacts are also the source of truth for MAPI NSPI and EAS GAL
 * (Global Address List) lookups against a mailbox's own address book.
 *
 * Extends `RecoverableBaseEntity` (soft delete, `deleted: boolean`) rather than plain `BaseEntity` — see the
 * identical note on `Folder`.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface Contact extends RecoverableBaseEntity {
    /** The unique identifier of the `Mailbox` this contact belongs to. */
    mailboxUid: string;

    /** The unique identifier of the `Folder` (of type `CONTACTS`) this contact resides in. */
    folderUid: string;

    /** The unique identifier of the `ContactList` this contact is a member of, if any. */
    contactListUid?: string;

    displayName: string;

    givenName?: string;

    surname?: string;

    emails: ContactEmail[];

    phones: ContactPhone[];

    addresses: ContactPostalAddress[];

    company?: string;

    jobTitle?: string;

    notes?: string;

    /** The key under which the contact's photo is stored in the `BlobStore`, if one has been set. */
    photoBlobKey?: string;

    /** The unique identifier of an external directory entry (e.g. GAL) this contact was sourced from, if any. */
    sourceUid?: string;
}

/**
 * Defines a named grouping (address book / distribution list) of `Contact` records within a `Mailbox`.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface ContactList extends BaseEntity {
    mailboxUid: string;

    name: string;
}

export enum AttendeeRole {
    REQUIRED = "required",
    OPTIONAL = "optional",
    RESOURCE = "resource",
}

export enum AttendeeResponseStatus {
    NEEDS_ACTION = "needsAction",
    ACCEPTED = "accepted",
    DECLINED = "declined",
    TENTATIVE = "tentative",
}

/** An embedded attendee of a `CalendarEvent`. */
export interface Attendee {
    address: string;
    displayName?: string;
    role: AttendeeRole;
    responseStatus: AttendeeResponseStatus;
    isOrganizer: boolean;
}

export enum RecurrenceFrequency {
    DAILY = "daily",
    WEEKLY = "weekly",
    MONTHLY = "monthly",
    YEARLY = "yearly",
}

/** An embedded RFC 5545 (`RRULE`)-style recurrence definition on a `CalendarEvent`. */
export interface RecurrenceRule {
    freq: RecurrenceFrequency;
    interval: number;
    byDay?: string[];
    byMonthDay?: number[];
    byMonth?: number[];
    count?: number;
    until?: Date;
    /** Specific occurrence dates removed from the recurrence set. */
    exceptions: Date[];
}

export enum CalendarEventStatus {
    TENTATIVE = "tentative",
    CONFIRMED = "confirmed",
    CANCELLED = "cancelled",
}

export enum BusyStatus {
    FREE = "free",
    BUSY = "busy",
    TENTATIVE = "tentative",
    OUT_OF_OFFICE = "oof",
}

/**
 * Defines a single calendar event/meeting stored in a `Folder` of type `CALENDAR`. External sharing and
 * scheduling permissions for the containing folder are governed by the platform's `AccessControlList` (see
 * `ACLAction`), not by any field on this type — see the architecture plan for the `"read"`/`"freebusy"`/
 * `"edit"`/`"delegate"` action convention.
 *
 * Extends `RecoverableBaseEntity` (soft delete, `deleted: boolean`) rather than plain `BaseEntity` — see the
 * identical note on `Folder`.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface CalendarEvent extends RecoverableBaseEntity {
    /** The unique identifier of the `Folder` (of type `CALENDAR`) this event resides in. */
    folderUid: string;

    /** The unique identifier of the `Mailbox` this event belongs to. */
    mailboxUid: string;

    title: string;

    location?: string;

    startDate: Date;

    endDate: Date;

    allDay: boolean;

    /** The IANA timezone identifier the event's start/end times were authored in. */
    timezone: string;

    organizer: Recipient;

    attendees: Attendee[];

    recurrenceRule?: RecurrenceRule;

    /** For a single occurrence of a recurring event that has been individually modified, its original start date. */
    recurrenceId?: Date;

    status: CalendarEventStatus;

    busyStatus: BusyStatus;

    /** The number of minutes before `startDate` that a reminder should be dispatched, if any. */
    reminderMinutesBeforeStart?: number;

    /** A stable identifier (RFC 5545 `UID`) for this event, shared across all clients/protocols and iTIP messages. */
    icalUid: string;

    /** The iTIP revision counter (RFC 5546 `SEQUENCE`), incremented on every scheduling-relevant change. */
    sequence: number;
}

/**
 * Supports anonymous, unauthenticated external access to a `CalendarEvent` folder's free/busy information (or
 * broader access, per `permittedActions`) via a shareable link. A calendar's sharing is otherwise just ordinary
 * `AccessControlList` management on its `Folder` (see `BaseFolderRoute`/`BaseScopedChildRoute`'s doc comments)
 * — this entity exists solely to add what a bare ACL record can't: a uniquely generated, revocable/expiring
 * credential a link recipient doesn't have to authenticate to use. `token` is granted directly as a real
 * `ACLRecord` (`{userOrRoleId: token, actions: permittedActions}`) on the shared folder's own
 * `AccessControlList` by `BaseCalendarShareLinkRoute` (revoked the same way on delete/expiry) — an anonymous
 * request presenting it via `?shareToken=` is resolved into a synthetic identity checked by the exact same
 * `ACLUtils.hasPermission()` call every other caller goes through (see `BaseScopedChildRoute`'s
 * `resolveEffectiveUser()`). There is no separate lookup route or bespoke permission model for it.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface CalendarShareLink extends BaseEntity {
    /**
     * The unique, unguessable token embedded in the shared URL, minted server-side (see
     * `BaseCalendarShareLinkRoute.create()`) and immutable thereafter. Doubles as the `userOrRoleId` of the
     * `ACLRecord` this link grants on its `folderUid`'s `AccessControlList`.
     */
    token: string;

    /**
     * The unique identifier of the `Folder` (of type `CALENDAR`) being shared. Managing this share link itself
     * (create/list/delete, by someone with access to the calendar) is permission-checked against this folder's
     * `AccessControlList`, the same as every other folder-scoped child entity in this library — see the
     * architecture note on `Message.mailboxUid`.
     */
    folderUid: string;

    /** The actions (see `ACLAction`) granted to holders of this link, e.g. `["freebusy"]` or `["read"]`. */
    permittedActions: string[];

    /** The date/time after which this link is no longer valid. */
    expiresAt?: Date;

    createdByUserUid: string;
}

export enum TaskPriority {
    LOW = "low",
    NORMAL = "normal",
    HIGH = "high",
}

/**
 * Defines a single to-do item stored in a `Folder` of type `TASKS`.
 *
 * Extends `RecoverableBaseEntity` (soft delete, `deleted: boolean`) rather than plain `BaseEntity` — see the
 * identical note on `Folder`.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface Task extends RecoverableBaseEntity {
    mailboxUid: string;

    folderUid: string;

    title: string;

    body?: string;

    dueDate?: Date;

    completed: boolean;

    priority: TaskPriority;

    reminderDate?: Date;
}

/**
 * Defines a single free-form note stored in a `Folder` of type `NOTES`.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface Note extends BaseEntity {
    mailboxUid: string;

    folderUid: string;

    title: string;

    body: string;

    /** An optional display color hint (e.g. a hex code) for the note, as commonly supported by note UIs. */
    color?: string;
}

/** The kind of record a `ScanResult` was produced for. */
export enum ScanTargetType {
    MESSAGE = "message",
    ATTACHMENT = "attachment",
}

export enum SpamVerdict {
    CLEAN = "clean",
    SUSPECT = "suspect",
    SPAM = "spam",
}

export enum AvVerdict {
    CLEAN = "clean",
    INFECTED = "infected",
    ERROR = "error",
}

/**
 * Defines the recorded outcome of running the SPAM/AV `ScanPipeline` against a `Message` or `Attachment`.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface ScanResult extends BaseEntity {
    targetType: ScanTargetType;

    /** The unique identifier of the `Message` or `Attachment` (per `targetType`) that was scanned. */
    targetUid: string;

    spamScore: number;

    spamVerdict: SpamVerdict;

    /** The symbolic names (e.g. rspamd symbols) that contributed to the spam verdict. */
    spamSymbols: string[];

    avVerdict: AvVerdict;

    /** The name of the malware signature matched, if `avVerdict` is `INFECTED`. */
    avSignatureName?: string;

    scannedAt: Date;

    /** The version identifiers of the spam/AV engines used, for auditability as signatures update over time. */
    providerVersions: { spam?: string; av?: string };
}

export enum QuarantineReason {
    INFECTED = "infected",
    SPAM_POLICY = "spam_policy",
    OTHER = "other",
}

/**
 * Defines a single message held out of normal delivery pending review, because it was found infected or
 * because organizational policy quarantines spam above a configured threshold rather than delivering to Junk.
 * A quarantined message never appears in any `Folder` or client sync until released.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface QuarantineEntry extends BaseEntity {
    /** The unique identifier of the `Mailbox` the message was addressed to. */
    mailboxUid: string;

    /** The unique identifier of the `Message` record, if one was ever created for this delivery attempt. */
    originalMessageUid?: string;

    reason: QuarantineReason;

    scanResultUid: string;

    /** The key under which the original raw MIME source is stored in the `BlobStore`. */
    rawBlobKey: string;

    releasedAt?: Date;

    releasedByUserUid?: string;
}

/**
 * Tracks whether a given entity's content is currently reflected in a specific `SearchProvider`'s index,
 * decoupling "committed to the primary datastore" from "visible in search" (the two are only eventually
 * consistent, reconciled by `SearchIndexJob`).
 *
 * @author Jean-Philippe Steinmetz
 */
export interface SearchIndexState extends BaseEntity {
    entityType: string;

    entityUid: string;

    /** The name of the `SearchProvider` implementation this state row applies to. */
    provider: string;

    indexedAt: Date;

    /** A content hash used to detect whether re-indexing is needed after this state was last recorded. */
    contentHash: string;
}

export enum IngestStatus {
    PENDING = "pending",
    SCANNING = "scanning",
    DELIVERED = "delivered",
    FAILED = "failed",
}

/**
 * A staging record for one raw message accepted by the MTA (Postfix) and handed to `MailIngestRoute`, before
 * scanning/parsing/delivery has run. Kept separate from `QuarantineEntry` (which holds messages that *failed*
 * scanning) so the two lifecycles — "not yet scanned" vs. "scanned and held" — aren't conflated. Drained by
 * `ScanQueueJob`, which runs the `ScanPipeline` and then either delivers the message to a `Folder`, files it in
 * `QuarantineEntry`, or (on repeated processing failure) marks this entry `FAILED` for operator review.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface IngestQueueEntry extends BaseEntity {
    /** The resolved `Mailbox` this message is addressed to. */
    mailboxUid: string;

    envelopeFrom: string;

    envelopeTo: string[];

    /** The key under which the raw MIME source is stored in the `BlobStore`. */
    rawBlobKey: string;

    status: IngestStatus;

    errorMessage?: string;
}

/**
 * Tracks the EAS sync state of a single paired mobile device against a `Mailbox`.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface DeviceSyncState extends BaseEntity {
    mailboxUid: string;

    deviceId: string;

    deviceType: string;

    /** The EAS provisioning policy key most recently acknowledged by the device. */
    policyKey?: string;

    /** The per-folder EAS `SyncKey` cursor, keyed by `Folder.uid`. */
    folderSyncKeys: Record<string, string>;

    lastSyncAt?: Date;

    provisioned: boolean;
}
