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
 * Describes a cryptographic public key used to sign or encrypt messages between parties - published via the
 * federation discovery protocol (`.well-known/rapidmx/keys/:hash`, see `util/FederationUtils.ts`/
 * `util/KeyDiscoveryClient.ts`) and stored on both `Mailbox.keys` (this server's own users) and `Contact.keys`
 * (third parties discovered via that protocol). MUST NOT ever carry private key material - see
 * `WrappedPrivateKey`/`MasterKeyWrap`/`KeyVault` (below) for the corresponding private-material-carrying
 * types, returned only from the authenticated key-vault endpoints that actually need them, never alongside a
 * `PublicKey`.
 */
export interface PublicKey {
    /** The base64 encoded public key (DER-encoded X.509 certificate). */
    publicKey: string;
    /** The key's type and format (e.g. `x509`). */
    type: string;
    /** The purpose this key is used for. */
    useType: "sign" | "encrypt";
    /** SHA-256 fingerprint of the certificate, hex encoded. Used for TOFU pinning and out-of-band verification. */
    fingerprint: string;
    /** UTC timestamp (epoch ms) at which this key becomes valid. */
    notBefore: number;
    /** UTC timestamp (epoch ms) at which this key expires. */
    notAfter: number;
    /** UTC timestamp (epoch ms) at which this key was revoked, if applicable. */
    revokedAt?: number;
}

/**
 * Describes the encryption preference of a `Mailbox` (this server's own users) or `Contact` (a third party
 * discovered via the federation protocol) - whether messages to/from that address should default to
 * encrypted. A client defaults to encrypting only when **both** sender and recipient report `"mutual"` - see
 * the Encryption section of `specs/end-to-end_encryption.md`.
 */
export interface EncryptionPreference {
    /** UTC timestamp (epoch ms) of the most recent effective date this preference was observed/set - used by
     * the spec's Anti-Downgrade rule to reject a stale update (an older message must never regress a newer
     * preference already on file). */
    lastSeen?: number;
    /** The encryption preference to apply to outgoing messages. */
    preferEncrypt: "mutual" | "nopreference";
}

/**
 * A private key encrypted under a mailbox's master key (MK) - only ever returned from an authenticated
 * `GET /mailbox/:id/keyvault` call (`KeyVault`, below), never from an ordinary `Mailbox` fetch. The server
 * never sees the unwrapped private key or the master key that wraps it - `ciphertext`/`nonce`/`algorithm` are
 * opaque to this app, produced and consumed entirely client-side.
 */
export interface WrappedPrivateKey {
    /** AEAD ciphertext of the private key, base64 encoded. */
    ciphertext: string;
    /** Base64 encoded AEAD nonce. */
    nonce: string;
    /** AEAD algorithm identifier (e.g. `AES-256-GCM`). */
    algorithm: string;
    /** Fingerprint of the corresponding `PublicKey`. */
    fingerprint: string;
    /** The purpose this key is used for. */
    useType: "sign" | "encrypt";
}

/**
 * One wrapped copy of a mailbox's master key, per unlock method - a mailbox typically has several of these
 * (e.g. one per registered passkey, plus a password-derived one), any of which independently unwraps the same
 * underlying master key client-side. Removing a wrap only prevents *future* unlocks by that method; it does
 * not revoke access already granted via a captured wrap - true revocation requires the client to fully
 * re-key (see `BaseKeyVaultRoute`'s re-key endpoint), not merely delete a wrap.
 */
export interface MasterKeyWrap {
    /** Unlock method used to derive the wrapping key. */
    method: "password" | "passkey" | "recovery" | "escrow";
    /** Opaque identifier for the method instance (e.g. a WebAuthn credential ID). */
    methodId?: string;
    /** For method `escrow`: the escrow scope this wrap belongs to. Re-wrapped on scope change or key rotation.
     * A seed field only - full Escrow Scoping (named scopes, role-holders, dual control, matter-based access)
     * is its own deferred follow-up roadmap; this field exists now so that work never needs a breaking schema
     * migration. */
    escrowScopeId?: string;
    /** AEAD ciphertext of the master key, base64 encoded. */
    ciphertext: string;
    /** Base64 encoded AEAD nonce. */
    nonce: string;
    /** Base64 encoded KDF salt. */
    salt: string;
    /** KDF identifier and parameters (e.g. `argon2id:m=65536,t=3,p=4`). */
    kdf: string;
    /** Wrapping scheme version, so parameters can be upgraded over time. */
    schemeVersion: number;
    /** UTC timestamp (epoch ms) of creation. */
    createdAt: number;
}

/**
 * Holds a mailbox's private key material, wrapped under its own master key - returned only from the
 * authenticated `GET /mailbox/:id/keyvault` (`BaseKeyVaultRoute`), deliberately a separate entity from
 * `Mailbox` (not embedded fields on it) so private material can never leak via an ordinary `Mailbox` fetch.
 * Access is checked directly against the owning mailbox's own `AccessControlList` - unlike most entities in
 * this codebase, a trusted/admin role gets **no** automatic bypass here (see `BaseKeyVaultRoute`'s own doc
 * comment); any admin access that does occur is audit-logged.
 */
export interface KeyVault extends BaseEntity {
    /** The unique identifier of the `Mailbox` this key vault belongs to. Exactly one `KeyVault` row exists per
     * mailbox, enforced by `BaseKeyVaultRoute`'s own find-or-create logic rather than a database-level
     * one-to-one constraint (matching this codebase's existing `find({ field }, { limit: 1 })` lookup-by-field
     * convention, e.g. `BaseMailIngestRoute.findExactMailboxByAddress()`). */
    mailboxUid: string;

    wrappedKeys: WrappedPrivateKey[];

    masterKeyWraps: MasterKeyWrap[];
}

/**
 * The JSON body served from (and consumed from) the federation discovery endpoint,
 * `GET /.well-known/rapidmx/keys/:hash` - see `specs/end-to-end_encryption.md`'s "Public Endpoint" section.
 * `escrow` is a self-reported, unverifiable honesty signal (whether the serving domain holds a key capable
 * of decrypting this mailbox), never a guarantee.
 */
export interface KeyDiscoveryResponse {
    encryptPreference: EncryptionPreference;
    keys: PublicKey[];
    escrow: boolean;
}

/**
 * The three encryption-policy states `specs/end-to-end_encryption.md`'s "Encryption Policy States" section
 * requires - deliberately three, not a boolean: `optional` ("not by default") and `prohibited` ("not
 * allowed") are materially different administrative intents (privileged/legal-hold communication needs
 * `optional` even when routine encryption is otherwise off; supervisory-review obligations need
 * `prohibited`, which a plain "off" setting can't distinguish from `optional`).
 */
export type PolicyState = "automatic" | "optional" | "prohibited";

/**
 * The system-wide encryption policy, configured independently per recipient tier (see `util/DomainUtils.ts`'s
 * `RecipientTier`) - a singleton row, one per deployment, admin-editable via `PUT` and readable by any
 * authenticated user (a compose UI needs it to decide what encryption controls to offer, not just an admin).
 * The separate digital-signing enable/disable toggle is a plain deployment `@Config` boolean, not part of
 * this entity - the spec only requires tri-state granularity for *encryption*, not signing.
 */
export interface EncryptionPolicy extends BaseEntity {
    encryptSameOrg: PolicyState;
    encryptFederated: PolicyState;
    encryptExternal: PolicyState;
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

    /** `true` if this mailbox's out-of-office auto-reply (MS-ASSettings `Oof`) is currently enabled. */
    oofEnabled: boolean;

    /** The out-of-office auto-reply message body. A single combined message rather than the spec's three
     * audience-specific variants (internal/external-known/external-unknown) - a deliberate pragmatic-subset
     * simplification, matching this library's existing single-slot precedent elsewhere. */
    oofMessage: string;

    /** When set together with `oofEndTime`, the auto-reply is only active within this window rather than
     * indefinitely while `oofEnabled` is `true`. */
    oofStartTime?: Date;

    oofEndTime?: Date;

    /** `true` if this mailbox represents a bookable resource (Exchange's "room"/"equipment" mailbox
     * concept) rather than a person - see `resourceType`/the auto-accept fields below. A resource mailbox
     * is otherwise an ordinary `Mailbox` (still needs `ownerUserUid` unset - creating one is
     * trusted-role-only, same gate `BaseMailboxRoute.create()` already applies to any ownerless mailbox). */
    isResource?: boolean;

    /** Whether this resource is a `room` or `equipment` - only meaningful when `isResource` is `true`. */
    resourceType?: "room" | "equipment";

    /** Informational only (e.g. for a future room-picker UI) - not used by any accept/decline logic. */
    resourceCapacity?: number;

    /** Mirrors Exchange's `Set-CalendarProcessing -AutomateProcessing AutoAccept` (vs `None`) - off by
     * default, matching this codebase's "silently-enabling automated behavior needs an explicit opt-in"
     * convention (e.g. `mail:auto_provision:enabled`). Has no effect unless `isResource` is also `true`. */
    autoAcceptBookings?: boolean;

    /** Mirrors `-AllowConflicts $true` - when set, every request is auto-accepted regardless of existing
     * bookings (conflict checking is skipped entirely). */
    allowConflicts?: boolean;

    /** Mirrors `-BookingWindowInDays` - a request whose first occurrence starts further out than this many
     * days from now is auto-declined. `undefined` means no limit. */
    bookingWindowDays?: number;

    /** Mirrors `-MaximumDurationInMinutes` - a request longer than this is auto-declined. `undefined` means
     * no limit. */
    maxDurationMinutes?: number;

    /**
     * Whether `send()` attaches a real RFC 3798 receipt request (`Disposition-Notification-To`) to every
     * outgoing message by default, split by the recipient's `RecipientTier` (`util/DomainUtils.ts`'s
     * `classifyRecipientTier()`) - not one flat toggle: a message can have a mix of tiers among its
     * recipients, and `Disposition-Notification-To` is a single message-level header (RFC 3798 has no "only
     * notify me for these recipients" concept - every recipient's own system independently decides whether to
     * honor the request regardless), so the effective rule in `BaseMessageRoute.send()` is "attach it if it
     * applies to *any* recipient on the message". A per-draft `Message.requestReceipt` always overrides all
     * three of these at once when explicitly set.
     *
     * Receipt requests are a *disclosing* capability under `specs/end-to-end_encryption.md`'s Scoping
     * Principle, so they default to same-organisation only: `Internal` (same-org) defaults to `true`
     * ("silently sent" within this same system); `Federated` (a different organisation that has opted into
     * RapidMX's federated protocols, but whose users never agreed to *this* organisation's read-tracking
     * norms) and `External` both default to `false` - attaching a receipt request to a reply outside this
     * organisation would be unusual and is opt-in instead.
     */
    alwaysRequestReceiptInternal: boolean;

    alwaysRequestReceiptFederated: boolean;

    alwaysRequestReceiptExternal: boolean;

    /**
     * Whether this mailbox, as the *recipient* of a receipt request, sends one back immediately versus
     * holding it for the mailbox owner's explicit approval (`BaseMessageRoute`'s `POST /:id/receipt/approve`/
     * `/decline`) - again split by `RecipientTier`, this time classifying the *requester* (the address a
     * receipt would be sent back to). Internal defaults to `true` (send automatically - matches your "all
     * internal mail should always send/respond to receipt requests"); Federated and External both default to
     * `false` (held for approval by default - "anything outside this organisation should be opt-in by
     * default").
     *
     * This is a two-state design (auto-send vs. hold-for-approval), not three - there is no "never respond at
     * all, silently" state. A mailbox owner who always declines a given sender's pending requests achieves
     * the practical equivalent, just as an explicit per-message action rather than a silent standing rule.
     */
    autoSendReceiptsInternal: boolean;

    autoSendReceiptsFederated: boolean;

    autoSendReceiptsExternal: boolean;

    /** This mailbox's own encryption preference - whether outgoing messages from it should default to
     * encrypted (only when the recipient also reports `mutual`, per `specs/end-to-end_encryption.md`'s
     * Encryption section). Defaults to `{ preferEncrypt: "nopreference" }` for a mailbox with no preference
     * ever set - the same default shape the discovery endpoint (`KeyDiscoveryResponse`) reports for a mailbox
     * with nothing published yet, so a newly created mailbox and one intentionally reporting "no preference"
     * are indistinguishable to a caller, matching this app's own not-yet-configured defaults elsewhere
     * (`BaseBrandingRoute`/`BaseEncryptionPolicyRoute`). */
    encryptPreference: EncryptionPreference;

    /** This mailbox's published public keys (signing and/or encryption) - safe to expose publicly, unlike the
     * private-material-carrying `KeyVault` returned only from the authenticated `GET /mailbox/:id/keyvault`.
     * Defaults to `[]` for a mailbox that has never enrolled a key. */
    keys: PublicKey[];

    /** Precomputed `zbase32(sha256(lowercase(localPart)))` of `primarySmtpAddress` (see
     * `util/KeyDiscoveryClient.ts`'s `computeKeyDiscoveryHash()`), maintained alongside `primarySmtpAddress`
     * so the public discovery endpoint (`GET /.well-known/rapidmx/keys/:hash`) is an indexed lookup rather
     * than a per-request hash-everything scan. Computed on create and recomputed whenever `primarySmtpAddress`
     * changes (`BaseMailboxRoute`) - optional, not backfilled, rather than required-with-a-default, so a
     * mailbox that existed before this field was introduced is simply not yet discoverable rather than every
     * pre-existing row colliding on the same default value under a uniqueness constraint. */
    keyDiscoveryHash?: string;
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

    /**
     * An optional display color hint (e.g. a hex code), primarily used to distinguish multiple `CALENDAR`-type
     * folders within the same mailbox in a client's UI (a mailbox may have more than one — nothing prevents
     * creating additional named calendars via the ordinary `POST` route, only the well-known-folder
     * auto-provisioning path is limited to one). Same shape/purpose as `Note.color`.
     */
    color?: string;
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
 * Which half of a Focused Inbox split a `Message` belongs to - Outlook/Exchange's "Focused" vs "Other"
 * view of one Inbox (NOT two separate folders; both live in the same `FolderType.INBOX`). The string
 * values deliberately match Microsoft Graph's own `inferenceClassification` wire format, which is also
 * what MAPI (`PidTagInferenceClassification`) and EAS (`Email2:InferenceClassification`) expose, so the
 * sibling protocol packages can map this field straight through.
 */
export enum MessageClassification {
    FOCUSED = "focused",
    OTHER = "other",
}

/**
 * One row of `Message.receiptStatus` - the delivery/read status of one recipient of a sent message, the
 * client-visible indicator behind this library's whole delivery/read receipt design (see `util/
 * ReceiptUtils.ts`'s own doc comment). `recipientAddress` matches a real MDN's own `Final-Recipient` field.
 *
 * `deliveredAt`/`readAt` are ISO 8601 strings, not `Date` - deliberately: this type is stored inside a
 * `simple-json` column on the SQL backend, which round-trips through `JSON.stringify`/`JSON.parse` with no
 * transformer, so a nested `Date` comes back out as a string anyway (the same latent trap
 * `RecurrenceRule.until`/`.exceptions` already sit in, and the same fix already applied once this session to
 * `BookingDateOverride.date`) - a field that is genuinely a string to begin with can't be silently mistyped
 * that way.
 */
export interface MessageReceiptEntry {
    /** Normalized to lowercase. */
    recipientAddress: string;

    deliveredAt?: string;

    readAt?: string;
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

    /** The key under which the raw MIME source is stored in the `BlobStore`, unmodified from ingestion/send —
     * except that `send()`/`ScheduledSendJob` may rewrite it once, in place, to inject a `Message-ID` header a
     * drafted message didn't already have (see `MailSendUtils.scanAndRelay()`), so every recipient's own copy
     * and this mailbox's own Sent Items copy agree on the same identifier. */
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

    /** `true` when this message's body is S/MIME (CMS) encrypted - see `util/SmimeUtils.ts`'s
     * `isEncryptedBody()`, which `ScanPipeline.run()` computes this from at ingest/send time. Downstream
     * consumers that would otherwise try to read plaintext out of an encrypted body (`AttachmentExtractionJob`,
     * derived-entity creation from an encrypted calendar invite) key off of this rather than re-deriving it
     * themselves, since by the time they run the original `ScanPipelineResult` is long gone. */
    encrypted: boolean;

    /** The unique identifier of this message's `ScanResult`, once scanning has completed. */
    scanResultUid?: string;

    /** The timestamp this message was last (re)indexed for full-text search, if ever. */
    searchIndexedAt?: Date;

    /** When set to a future time, `send()` defers relay until then instead of sending immediately -
     * mirrors Outlook's "Do not deliver before" (`PR_DEFERRED_SEND_TIME`). The message sits in the mailbox's
     * `OUTBOX` folder until `ScheduledSendJob` relays it and clears this field. */
    scheduledSendTime?: Date;

    /** Set by `BaseMessageRoute.recall()` the moment a recall is requested — purely informational (lets a
     * client show "recall requested" immediately). The eventual outcome (each recipient's own `ScanQueueJob`
     * either deleting its still-unread copy or not) is reported back to the sender as an ordinary visible
     * email instead of being synced onto this field - see `ScanQueueJob.sendRecallReport()`. */
    recallRequestedAt?: Date;

    /** Groups this message with the rest of its RFC 5322/2822 thread - computed once at creation time via
     * `util/ConversationUtils.ts`'s `deriveConversationId()`, from this message's own `references`/
     * `inReplyTo`/`messageId`. Absent on a message written before this field existed - `conversations()`
     * (`BaseMessageRoute`) falls back to that message's own `uid` as a singleton conversation in that case. */
    conversationId?: string;

    /**
     * Which half of the Focused Inbox split this message belongs to, assigned once at delivery time by
     * `util/FocusedInboxUtils.ts`'s `classifyMessage()` (see `ScanQueueJob.deliverMessage()`). Only ever set
     * for mail actually delivered to the `INBOX` - junk-routed mail and mail a `MailFilterRule` moved
     * elsewhere are left unclassified, since Focused/Other is an Inbox-only concept.
     *
     * Absent on a message written before this field existed (and on every non-Inbox message), so a client
     * should treat absent as `FOCUSED` rather than hiding it: `?inferenceClassification=other` is the exact
     * Other view, and the Focused view is everything else. Pre-existing mail is deliberately not backfilled -
     * the same going-forward-only rollout Outlook's own Focused Inbox had.
     */
    inferenceClassification?: MessageClassification;

    /**
     * Set on a Draft, before calling `send()`, to request a real RFC 3798 MDN (`Disposition-Notification-To`)
     * from every recipient - see `util/ReceiptUtils.ts` and `ScanQueueJob.maybeSendReceipt()`/`processReceipt()`
     * for the full delivery/read receipt design. `undefined` means "use this mailbox's own
     * `alwaysRequestReceiptInternal`/`External` default" (see `Mailbox`); an explicit `true`/`false` here
     * always overrides both mailbox defaults at once, for every recipient regardless of internal/external.
     * Same "set via an ordinary PUT before calling send()" convention as `scheduledSendTime`. Meaningless
     * (never read) once the message has actually been sent.
     */
    requestReceipt?: boolean;

    /**
     * The address a receipt should be sent back to, persisted on the *recipient's own delivered copy* at
     * delivery time from the inbound `Disposition-Notification-To` header (see
     * `ScanPipelineResult.dispositionNotificationTo`) - needed because the read-receipt trigger fires later,
     * independently, whenever this message's `flags.read` transitions to `true`, with no access to the
     * original scan result any more.
     */
    dispositionNotificationTo?: string;

    /** Idempotency stamp, recipient's own delivered copy - set once a delivery receipt has actually been
     * sent for this message, so a re-run can never send a second one. */
    deliveryReceiptSentAt?: Date;

    /** Idempotency stamp, recipient's own delivered copy - set once a read receipt has actually been sent
     * (on the first `flags.read` transition to `true` that requests one), so re-reading the message never
     * sends a second one. */
    readReceiptSentAt?: Date;

    /** `true` when a delivery receipt was requested but the recipient mailbox's `autoSendReceiptsInternal`/
     * `External` setting held it for the mailbox owner's explicit approval instead of sending it immediately
     * - see `BaseMessageRoute`'s `POST /:id/receipt/approve`/`/decline`. Recipient's own delivered copy. */
    deliveryReceiptPending: boolean;

    /** Same as `deliveryReceiptPending`, for a read receipt. */
    readReceiptPending: boolean;

    /**
     * `true` once the mailbox owner has explicitly declined a pending delivery receipt via `POST
     * /:id/receipt/decline` - a separate, permanent "handled, don't ask again" marker distinct from
     * `deliveryReceiptPending`/`deliveryReceiptSentAt`. Needed because `deliveryReceiptPending` only means
     * "not currently awaiting approval" - without this field, an event that could re-trigger the same pending
     * decision (e.g. `readReceiptPending` after a message is marked unread then read again) would see the
     * same "never handled" state a decline was supposed to permanently rule out. Recipient's own delivered
     * copy.
     */
    deliveryReceiptDeclined: boolean;

    /** Same as `deliveryReceiptDeclined`, for a read receipt - checked by `BaseMessageRoute.update()`'s
     * read-receipt trigger guard so declining once truly means "don't re-prompt", even across a later
     * unread-then-read cycle. */
    readReceiptDeclined: boolean;

    /**
     * The per-recipient delivery/read roster - **the client-visible indicator**, shown on the *original sent*
     * message instead of a separate visible receipt email (see this library's whole receipt design). Seeded
     * by `send()` with one entry per address in `recipients` (both timestamps unset) whenever a receipt was
     * actually requested; grows further as real MDNs arrive and `ScanQueueJob.processReceipt()` correlates
     * them by `Final-Recipient` - including appending a wholly new entry for a `DistributionList` member
     * neither `send()` nor anything else could have known about in advance (see that method's own doc
     * comment). `undefined` (not an empty array) when no receipt was ever requested for this message at all.
     */
    receiptStatus?: MessageReceiptEntry[];
}

/**
 * A user's explicit "always put mail from this sender in Focused/Other" instruction, which overrides
 * whatever `classifyMessage()`'s heuristics would otherwise decide for that sender. Mirrors Microsoft
 * Graph's `inferenceClassificationOverride` (and Exchange's `Set-FocusedInboxOverride`) - the entity a
 * client writes when the user picks "Always move to Other" on a message.
 *
 * Per-mailbox and admin-free: exactly the same shape/ACL/route treatment as `MailFilterRule`, the library's
 * other per-mailbox user-configurable behavior entity.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface FocusedInboxOverride extends BaseEntity {
    /** The unique identifier of the `Mailbox` this override applies to. */
    mailboxUid: string;

    /** The sender address this override matches, normalized to lowercase (`util/AddressUtils.ts`'s
     * `normalizeAddress()`) so matching is case-insensitive the same way every other address comparison in
     * this library is. */
    senderAddress: string;

    /** Where mail from `senderAddress` should always go. */
    classifyAs: MessageClassification;
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

    /** Whether the caller has starred/favorited this contact. Absent/`undefined` is equivalent to `false` —
     * optional rather than a defaulted required field so that adding this column never requires backfilling a
     * NOT NULL value onto every pre-existing row in a SQL deployment. */
    favorite?: boolean;

    /** Free-form category labels (e.g. Outlook-style colored categories) applied to this contact, if any. */
    categories?: string[];

    /** This contact's known encryption preference, discovered via the federation protocol
     * (`util/KeyringUtils.ts`) - `undefined` until Discovery has ever run for this address, distinct from an
     * explicit `{ preferEncrypt: "nopreference" }` the contact has actually published. */
    encryptPreference?: EncryptionPreference;

    /** The public keys this contact has published, as last observed via Discovery. `undefined` until
     * Discovery has ever run for this address. */
    keys?: PublicKey[];

    /** UTC timestamp (epoch ms) at which this contact's keys were first observed - the TOFU (trust-on-first-
     * use) anchor referenced in `keyConflict`'s `observedAt` comparison and surfaced to the user so they can
     * judge a key change's plausibility (e.g. "first seen 3 years ago" vs. "first seen yesterday"). */
    keysFirstSeen?: number;

    /** UTC timestamp (epoch ms) of the most recent message observed from this contact, with or without a key
     * header - updated on every message regardless of outcome, per the Anti-Downgrade rule: a message with no
     * discoverable key must still update this field even though it must NOT touch `encryptPreference`/`keys`. */
    lastMessageSeen?: number;

    /** Set when an observed key conflicts with the currently pinned key for this contact - blocks silent
     * acceptance of the new key (`util/KeyringUtils.ts`'s Key Conflict Handling) until the user takes explicit
     * action. The previously pinned key in `keys`/`encryptPreference` is retained unchanged while this is set. */
    keyConflict?: {
        observedFingerprint: string;
        observedAt: number;
        source: "header" | "discovery";
    };
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

/**
 * A mail-enabled group: mail sent to `primarySmtpAddress`/`aliasAddresses` fans out to every address in
 * `memberAddresses`. A member address may resolve to an internal `Mailbox`, another `DistributionList` (nested
 * groups), or a fully external address (relayed out) — see `BaseMailIngestRoute`'s expansion logic.
 *
 * `uid` is this list's own normalized primary address (e.g. `sales@example.com`), not a random id — the same
 * convention `Mailbox.uid` uses, so cross-entity address collisions are a cheap `uid` lookup rather than a
 * separate field-uniqueness check. See `BaseMailboxRoute`/`BaseDistributionListRoute` for where `uid` is derived
 * and checked.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface DistributionList extends RecoverableBaseEntity {
    /** The primary SMTP address that mail addressed to this list is delivered/fanned-out under. */
    primarySmtpAddress: string;

    /** Additional SMTP addresses that also resolve to this list. */
    aliasAddresses?: string[];

    /** The display name of the list. */
    name: string;

    description?: string;

    /** Set only when a non-trusted caller could ever create one - kept for parity with `Mailbox.ownerUserUid`,
     * informational only (v1 has no delegated-ownership enforcement; list management is trusted-role-only). */
    ownerUserUid?: string;

    /** The email addresses of every member. Each may resolve to an internal `Mailbox`, a nested
     * `DistributionList`, or a genuinely external address (relayed out via `MailTransport`). */
    memberAddresses: string[];

    /** When `true`, inbound mail whose envelope sender isn't (case-insensitively) one of `memberAddresses` is
     * dropped rather than fanned out. Enforced only at `BaseMailIngestRoute.deliver()`-time, not at the MTA's
     * RCPT-TO stage (`GET /internal/mta/resolve` takes no sender parameter). */
    restrictSenders?: boolean;
}

/**
 * Defines a named grouping of `Task` records within a `Mailbox` — the `Task` analog of `ContactList`.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface TaskList extends BaseEntity {
    mailboxUid: string;

    name: string;
}

/** The kind of action a `MailFilterRule` performs once its `MailFilterConditions` match - mirrors MAPI's
 * `PR_RULE_ACTIONS` action types (a pragmatic subset: `OP_MOVE`/`OP_COPY`/`OP_DELETE`/`OP_MARK_AS_READ`/
 * `OP_FORWARD`). */
export enum MailFilterActionType {
    MOVE_TO_FOLDER = "move_to_folder",
    COPY_TO_FOLDER = "copy_to_folder",
    DELETE = "delete",
    MARK_AS_READ = "mark_as_read",
    FORWARD = "forward",
}

/** An embedded action on a `MailFilterRule`. */
export interface MailFilterAction {
    type: MailFilterActionType;

    /** The unique identifier of the destination `Folder`. Required for `MOVE_TO_FOLDER`/`COPY_TO_FOLDER`. */
    folderUid?: string;

    /** The address to forward the message to. Required for `FORWARD`. */
    forwardTo?: string;
}

/** The embedded match criteria on a `MailFilterRule`. Every populated field must match (AND) for the rule to
 * fire; each field that holds an array is itself OR-matched against its entries. A pragmatic subset of MAPI's
 * restriction-based `PR_RULE_CONDITION`, not a general expression tree. */
export interface MailFilterConditions {
    /** Matches if the message's From address or display name contains any of these substrings (case-insensitive). */
    fromContains?: string[];

    /** Matches if the message's subject contains any of these substrings (case-insensitive). */
    subjectContains?: string[];

    /** Matches if the message's plain-text body preview contains any of these substrings (case-insensitive). */
    bodyContains?: string[];

    /** Matches if any To/Cc recipient address equals one of these addresses (case-insensitive). */
    toCcContains?: string[];

    hasAttachment?: boolean;

    importance?: MessageImportance;
}

/**
 * Defines a single mailbox-scoped inbox rule (MAPI/Outlook "Rules Wizard" rule, MS-OXORULE) - a set of
 * conditions matched against newly-delivered mail, and an ordered set of actions to take when they match.
 * Evaluated by `ScanQueueJob` immediately after a message is verdicted "deliver" (junk-routed mail never runs
 * inbox rules, matching Exchange's own behavior), before it's filed into the mailbox's Inbox.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface MailFilterRule extends BaseEntity {
    mailboxUid: string;

    name: string;

    enabled: boolean;

    /** Evaluation order, ascending - mirrors MAPI `PR_RULE_SEQUENCE`. */
    sequence: number;

    /** Mirrors the Rules Wizard's "stop processing more rules" checkbox / MAPI `ST_EXIT_LEVEL` - when `true` and
     * this rule matches, no rule with a higher `sequence` is evaluated for the same message. */
    stopProcessingRules: boolean;

    conditions: MailFilterConditions;

    actions: MailFilterAction[];
}

/** The kind of action a `TransportRule` performs once its `TransportRuleConditions` match. Unlike
 * `MailFilterActionType` (which only ever affects one already-resolved mailbox's own copy), these act on the
 * whole SMTP transaction - see the `TransportRule` doc comment. */
export enum TransportRuleActionType {
    /** Drops the message entirely (no recipient receives it) and sends a rejection notice to the sender. */
    REJECT = "reject",

    /** Routes every resolved recipient's copy to the existing quarantine mechanism instead of normal
     * delivery/relay - see `IngestQueueEntry.quarantineReason`. */
    QUARANTINE = "quarantine",

    /** Tags the message with an additional header - e.g. for downstream compliance tooling. Only adding a
     * header is supported, not modifying/removing an existing one. */
    ADD_HEADER = "add_header",

    /** Delivers an additional copy of the message to a configured address (e.g. BCC to a compliance
     * mailbox), resolved through the exact same mailbox/distribution-list/external logic as any other
     * recipient. */
    ADD_RECIPIENT = "add_recipient",
}

/** An embedded action on a `TransportRule`. */
export interface TransportRuleAction {
    type: TransportRuleActionType;

    /** The header name to add. Required for `ADD_HEADER`. */
    headerName?: string;

    /** The header value to add. Required for `ADD_HEADER`. */
    headerValue?: string;

    /** The address to also deliver a copy to. Required for `ADD_RECIPIENT`. */
    recipientAddress?: string;
}

/** The embedded match criteria on a `TransportRule`, evaluated once against the whole SMTP transaction (all
 * recipients at once) rather than per-mailbox - see `MailFilterConditions` for the analogous per-mailbox
 * shape this pragmatic subset mirrors. Every populated field must match (AND); a field holding an array of
 * strings is itself OR-matched against its entries. */
export interface TransportRuleConditions {
    /** Matches if the message's From address contains any of these substrings (case-insensitive). */
    fromContains?: string[];

    /** Matches if the message's subject contains any of these substrings (case-insensitive). */
    subjectContains?: string[];

    /** Matches if the message's plain-text body preview contains any of these substrings (case-insensitive). */
    bodyContains?: string[];

    /** Matches if any envelope recipient address contains any of these substrings (case-insensitive). */
    recipientContains?: string[];

    /** Matches if any envelope recipient's domain is not one of this server's configured `mail:domains`. */
    anyRecipientExternal?: boolean;

    hasAttachment?: boolean;

    /** Matches if any attachment's filename contains any of these substrings (case-insensitive). */
    attachmentNameContains?: string[];
}

/**
 * Defines a single org-wide, admin-managed mail-flow rule (Exchange "transport rule" / Google Workspace
 * "content compliance rule") - a set of conditions matched against every message crossing this mail system,
 * and an ordered set of actions to take when they match. Evaluated once per SMTP transaction by
 * `BaseMailIngestRoute.deliver()`, before that message is resolved/fanned out to any individual mailbox -
 * unlike `MailFilterRule`, which is per-mailbox and evaluated only after that fan-out and AV/spam scanning
 * have already happened. Admin-managed only (no per-record ACL - see `BaseTransportRuleRoute`).
 *
 * @author Jean-Philippe Steinmetz
 */
export interface TransportRule extends BaseEntity {
    name: string;

    enabled: boolean;

    /** Evaluation order, ascending - same convention as `MailFilterRule.sequence`. */
    sequence: number;

    /** When `true` and this rule matches, no rule with a higher `sequence` is evaluated for the same message -
     * same convention as `MailFilterRule.stopProcessingRules`. */
    stopProcessingRules: boolean;

    conditions: TransportRuleConditions;

    actions: TransportRuleAction[];
}

/** The kind of admin/policy or sensitive mailbox-content action an `AuditLogEntry` records - see that
 * interface's own doc comment for this pass's scope. Extensible for future roadmap items (e.g. domains
 * management). */
export enum AuditAction {
    MAILBOX_CREATE = "mailbox.create",
    DISTRIBUTION_LIST_CREATE = "distribution_list.create",
    DISTRIBUTION_LIST_UPDATE = "distribution_list.update",
    DISTRIBUTION_LIST_DELETE = "distribution_list.delete",
    TRANSPORT_RULE_CREATE = "transport_rule.create",
    TRANSPORT_RULE_UPDATE = "transport_rule.update",
    TRANSPORT_RULE_DELETE = "transport_rule.delete",
    MESSAGE_DELETE = "message.delete",
    MESSAGE_RECALL = "message.recall",
    DOMAIN_CREATE = "domain.create",
    DOMAIN_UPDATE = "domain.update",
    DOMAIN_DELETE = "domain.delete",
    DOMAIN_VERIFIED = "domain.verified",
    BRANDING_UPDATE = "branding.update",
    ENCRYPTION_POLICY_UPDATE = "encryption_policy.update",
    KEY_VAULT_ENROLL = "key_vault.enroll",
    KEY_VAULT_WRAP_ADD = "key_vault.wrap_add",
    KEY_VAULT_WRAP_REMOVE = "key_vault.wrap_remove",
    KEY_VAULT_REKEY = "key_vault.rekey",
    /** `GET /mailbox/:id/keyvault` - the one key-vault operation that reads wrapped key material (including,
     * via `masterKeyWraps`, an escrow wrap) rather than writing it. See `BaseKeyVaultRoute.get()`. */
    KEY_VAULT_READ = "key_vault.read",
}

/**
 * An admin-managed domain this mail server accepts mail on, and restricts `Mailbox`/`DistributionList`
 * addresses to. A newly created domain starts unverified with a generated `verificationToken` - an admin
 * must prove DNS ownership by adding it as a TXT record before the domain is usable anywhere this
 * server's domain list is consulted (see `util/DomainUtils.ts`'s `getVerifiedDomainNames()`). See
 * `util/DomainVerificationUtils.ts` for the exact TXT record format and lookup logic, `BaseDomainRoute`
 * for the manual `POST /:id/verify` action, and `jobs/DomainVerificationJob.ts` for the periodic
 * background check. Real DNS/DMARC record management beyond this one ownership check is a separate
 * roadmap item.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface Domain extends BaseEntity {
    /** The hostname this mail server accepts mail on, e.g. "example.com". */
    name: string;

    /** Admin on/off toggle, independent of verification - a disabled domain is excluded from every
     * restriction check without losing its row or verification state. */
    enabled: boolean;

    /** Whether DNS ownership has been proven via `verificationToken`. Only an enabled AND verified
     * domain counts as one of "this server's domains" anywhere that's consulted. Once true, this
     * library never flips it back to false - removing the TXT record after proving it once is fine. */
    verified: boolean;

    /** The random token that must appear in a TXT record on `name` (as
     * `rapidmx-domain-verification=<token>`, see `DomainVerificationUtils.ts`) to prove ownership.
     * Server-generated on create, regenerated if `name` is ever changed; never client-settable. */
    verificationToken: string;

    /** When `verified` became `true`, if it has. */
    verifiedAt?: Date;

    /** Last time a verification check (background job or manual trigger) ran against this domain,
     * whether or not it succeeded - lets an admin see the check is actually happening. */
    lastCheckedAt?: Date;

    /** DKIM selector, e.g. "default" - the MTA/OpenDKIM key pair this server signs (or a deployment's own
     * externally-managed one) is filed under this selector name. Auto-populated by `BaseDomainRoute` when
     * a `DkimKeyProvider` is registered (see its own doc comment); a deployment that hasn't registered one
     * still expects an admin to fill this in by hand from their own OpenDKIM keygen output. */
    dkimSelector?: string;

    /** The base64 public-key portion of that same DKIM key pair (the `p=` value), used to compute and
     * check the `<dkimSelector>._domainkey.<name>` TXT record. */
    dkimPublicKey?: string;

    /** DMARC policy to recommend/check for - defaults to the safe "none" (monitor-only) starting point
     * recommended by every DMARC deployment guide if not customized. */
    dmarcPolicy?: "none" | "quarantine" | "reject";

    /** Optional mailto target for DMARC aggregate reports (the record's `rua=` tag), if the admin wants
     * reports sent somewhere. */
    dmarcReportEmail?: string;
}

/**
 * A single, admin-managed, publicly-readable record of this deployment's custom branding (logo, product
 * title/company name, stylesheet, and web-client UI chrome) - what a downstream server or web client
 * renders instead of this library's own defaults. Always exactly one row, at the well-known `uid:
 * "branding"` - `BaseBrandingRoute` creates it lazily on the first admin write and never on a public read.
 *
 * Deny-all class ACL like every other admin-managed entity in this library - `"anonymous"` is never
 * granted anything through the ACL system (see the incident documented on `BaseMailboxRoute`); the public
 * `GET /branding` is a route-level decision `BaseBrandingRoute` makes itself, not an ACL grant.
 *
 * `logoUrl`/`iconUrl`/`stylesheetUrl` each support two independent ways for an admin to set them: a plain
 * external URL (the admin already hosts the asset elsewhere), or an upload through `BaseBrandingRoute`'s
 * own `POST /branding/logo`/`POST /branding/icon`/`POST /branding/stylesheet`, which stores the file via
 * `BlobStore` and rewrites the URL to this API's own `GET /branding/logo`/`GET /branding/icon`/
 * `GET /branding/stylesheet`. The `*BlobKey`/`*ContentType` fields are route-managed bookkeeping for the
 * upload case only - never client-settable directly, and never returned by the public `GET /branding` (see
 * `BaseBrandingRoute.toPublicBranding()`) - they exist so the route can tell whether the current
 * `logoUrl`/`iconUrl`/`stylesheetUrl` is self-hosted (and needs its blob cleaned up if replaced) versus
 * merely an external link with nothing here to serve.
 *
 * `logoUrl` is the full logo/watermark; `iconUrl` is a separate, independently configurable compact mark
 * for nav-header use - no fallback between the two is enforced here, consumers decide how to fall back.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface Branding extends BaseEntity {
    companyName: string;

    /** Browser-tab / product title shown by the web client. */
    title: string;

    /** The URL a client should render as the logo - either an admin-set external URL, or this API's own
     * `/branding/logo` once uploaded. */
    logoUrl?: string;

    /** Internal, route-managed only - set only when `logoUrl` currently points at an uploaded blob. */
    logoBlobKey?: string;

    /** Internal, route-managed only - the content-type `GET /branding/logo` serves the uploaded logo back
     * with. */
    logoContentType?: string;

    /** The URL a client should render as the compact nav-header icon, as opposed to `logoUrl`'s full
     * logo/watermark - either an admin-set external URL, or this API's own `/branding/icon` once uploaded. */
    iconUrl?: string;

    /** Internal, route-managed only - set only when `iconUrl` currently points at an uploaded blob. */
    iconBlobKey?: string;

    /** Internal, route-managed only - the content-type `GET /branding/icon` serves the uploaded icon back
     * with. */
    iconContentType?: string;

    stylesheetUrl?: string;

    /** Internal, route-managed only - set only when `stylesheetUrl` currently points at an uploaded blob. */
    stylesheetBlobKey?: string;

    /** Internal, route-managed only - the content-type `GET /branding/stylesheet` serves the uploaded
     * stylesheet back with. */
    stylesheetContentType?: string;

    /** Free-form UI chrome the web client renders above the mail app - never touched by this library
     * beyond storing/returning it verbatim. */
    headerHtml?: string;

    /** Free-form UI chrome the web client renders below the mail app. */
    footerHtml?: string;
}

/**
 * A single durable, admin-queryable record of "who did what, when" - Exchange's Admin/Mailbox Audit Log
 * concept. Written only by `util/AuditLogUtils.ts`'s `recordAuditLog()` (called directly from the handful
 * of admin/policy and sensitive mailbox-content routes this covers - see `AuditAction`'s own doc comment
 * for the exact scope), never created/updated/deleted through this entity's own route (see
 * `BaseAuditLogRoute`'s doc comment for how that's enforced) - an audit trail that could be edited via the
 * same API it's meant to hold accountable wouldn't be trustworthy.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface AuditLogEntry extends BaseEntity {
    /** The mailbox this action pertains to, if any - absent for an org-wide action (a `DistributionList`/
     * `TransportRule` change isn't scoped to one mailbox). */
    mailboxUid?: string;

    /** The uid of the user who performed this action, if a human caller (vs. a background job). */
    actorUserUid?: string;

    action: AuditAction;

    /** The entity type this action was performed on, e.g. `"Mailbox"`, `"DistributionList"`,
     * `"TransportRule"`, `"Message"`. */
    targetType: string;

    /** The uid of the specific record this action was performed on. */
    targetUid: string;

    /** The caller's IP address (`NetUtils.getIPAddress()`, trusted-proxy-aware), if available. */
    ip?: string;

    /** A small, action-specific identifying snapshot (e.g. the affected address/name) - not a full
     * field-level diff of what changed. */
    details?: Record<string, any>;
}

/**
 * Defines a single named, roaming email signature (OWA/New Outlook-style server-side signature, as opposed to
 * Desktop Outlook's local-only signatures) belonging to a `Mailbox`. This library does not compose message
 * bodies itself (see `BaseMessageRoute.send()`'s own doc comment - `bodyBlobKey` is always already fully
 * composed by the caller), so inserting a signature into a drafted message is each composing client's own
 * responsibility (webmail compose, EAS `SendMail`/`SmartReply`/`SmartForward`, MAPI's submit handler); this
 * entity plus `resolveDefaultSignature()` (`util/MailSignatureUtils.ts`) exist so that "which signature applies"
 * logic isn't reimplemented per client.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface MailSignature extends BaseEntity {
    mailboxUid: string;

    name: string;

    /** `@Nullable` despite being a plain `string` on the concrete entity classes - same reasoning as
     * `Mailbox.oofMessage`: an empty signature body is a legitimate "not written yet" default. */
    contentHtml: string;

    /** Applied to new (non-reply/forward) compositions when `true`. At most one signature per mailbox should have
     * this set - enforced by convention (the composing client toggles the previous default off), not by a DB
     * constraint, matching this codebase's existing level of cross-record validation elsewhere. */
    isDefaultForNewMessages: boolean;

    /** Applied to replies/forwards when `true` - mirrors OWA's separate "Replies/forwards" signature selector. */
    isDefaultForReplyForward: boolean;
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

    /** When `true`, this event's own [`startDate`, `endDate`] window independently triggers an automatic-reply
     * period for the mailbox, in addition to (not instead of) the mailbox-level `Mailbox.oofEnabled` toggle -
     * lets a "Vacation" calendar event configure its own out-of-office window/message in the same create call,
     * without touching `Mailbox.oofEnabled`/`oofStartTime`/`oofEndTime` at all. Same shape/precedent as the
     * existing `reminderMinutesBeforeStart` optional trigger field. See `resolveActiveOof()` (`util/OofUtils.ts`)
     * for how this combines with the mailbox-level toggle. */
    autoReplyEnabled?: boolean;

    /** The automatic-reply body to use while this event's window is active. Only meaningful when
     * `autoReplyEnabled` is `true`. */
    autoReplyMessage?: string;

    /** The `sequence` value as of the last time invites were successfully sent to attendees - lets
     * `MeetingSchedulingJob` tell "just added/changed, not yet invited" apart from "already invited,
     * nothing new to send." `undefined` means never invited. */
    inviteSequenceSent?: number;

    /** Set once an iTIP CANCEL has been sent to attendees for this event (triggered by `status:
     * CANCELLED` or by deleting the event) - prevents resending on every poll. */
    cancelNoticeSentAt?: Date;

    /**
     * Provenance for this event's encryption state, per `specs/search.md` §3 "Provenance" (refining
     * `specs/end-to-end_encryption.md`'s "Derived Entities" section, which this field originally implemented
     * as a plain boolean). `"derived"` and `"originated"` MUST stay distinguishable so a client can explain
     * *why* an event is encrypted ("received encrypted from bob@orgb.com" vs. "you chose to encrypt this") -
     * see `EncryptionOrigin`'s own doc comment. Only `ScanQueueJob`'s inbound iTIP pipeline sets `"derived"`
     * today (an ordinary client `POST`/`PUT` could set `"originated"` itself - ordinary CRUD, not specially
     * protected, since this field gates indexing behavior only, not access; a client that lies about it only
     * under-indexes its own event, not anyone else's data).
     *
     * Actual field-level encryption of `title`/`location`/attachments (leaving `startDate`/`endDate`/
     * `attendees`/RSVP status plaintext, per the spec's "Field Split") requires the client-side E2E
     * composition/decryption work this repo defers - today `ScanQueueJob`'s iTIP pipeline only ever reads a
     * `text/calendar` part that's already plaintext-visible to the server, so `"derived"` is set defensively
     * (never false-negative) rather than something the current pipeline exercises in the common case.
     * **Sticky**: once set to anything but `"none"`, an update, cancellation, or any instance of a recurring
     * series MUST preserve it rather than recomputing it from whatever triggered that particular mutation -
     * see `ScanQueueJob.processItipRequest()`.
     */
    encryptionOrigin: EncryptionOrigin;
}

/**
 * Governs behaviour on edit/update/duplication for an encrypted derived or originated entity - not a security
 * control (ciphertext is self-evident to the server either way), but the UI needs it to explain *why* an item
 * is encrypted. See `specs/search.md` §3 "Provenance".
 */
export type EncryptionOrigin =
    /** Not encrypted. */
    | "none"
    /** Materialised from an encrypted message received from a federated peer or external sender. */
    | "derived"
    /** Encrypted by explicit choice of this user. */
    | "originated";

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

/**
 * A single recurring weekly window during which a `BookingType` can be booked, expressed in that booking
 * type's own `timezone` as minutes from local midnight (so `540`-`1020` is 09:00-17:00 local, and stays
 * 09:00-17:00 local across a daylight-saving transition rather than drifting by an hour the way a stored UTC
 * instant would).
 */
export interface BookingAvailabilityWindow {
    /** The day of the week this window applies to: `0` (Sunday) through `6` (Saturday). */
    dayOfWeek: number;

    /** The inclusive start of the window, in minutes from local midnight. */
    startMinute: number;

    /** The exclusive end of the window, in minutes from local midnight. `1440` is the end of the day. */
    endMinute: number;
}

/**
 * Replaces a `BookingType`'s weekly `availability` for one specific calendar date - the "I'm only free in the
 * morning that Tuesday" / "I'm out that Friday" escape hatch.
 *
 * `date` is a plain `YYYY-MM-DD` string rather than a `Date` for two independent reasons. Semantically it is a
 * local calendar date in the booking type's `timezone`, not an instant - a `Date` would have to pick some
 * arbitrary UTC time of day to represent "the 4th of July" and would then land on the wrong day for a caller in
 * a different zone. Practically, this type is stored inside a `simple-json` column on the SQL backend, which
 * round-trips through `JSON.stringify`/`JSON.parse` with no transformer, so a nested `Date` comes back out as
 * an ISO *string* anyway (the same latent trap `RecurrenceRule.until`/`exceptions` already sit in) - a field
 * that is genuinely a string to begin with can't be silently mistyped that way.
 */
export interface BookingDateOverride {
    /** The local calendar date, in the booking type's `timezone`, as `YYYY-MM-DD`. */
    date: string;

    /** The windows available on that date. An EMPTY array is meaningful and deliberate: it is a blackout, i.e.
     * the day is closed even though the weekly `availability` would otherwise open it. */
    windows: BookingAvailabilityWindow[];
}

/**
 * Defines a single bookable offering owned by a `Mailbox` - the Calendly-style "30 minute intro call" a
 * completely unauthenticated visitor can pick a slot from and book. Availability is expressed as recurring
 * weekly `availability` windows plus per-date `dateOverrides`, and is intersected at request time against the
 * owning mailbox's real calendar (see `util/FreeBusyUtils.ts`) so a slot is only ever offered if the host is
 * genuinely free.
 *
 * Anonymous access to this entity is NOT granted through the `AccessControlList` - the class ACL is deny-all
 * like every other admin/owner-managed entity here, and `BaseBookingRoute` (the public route) does its own
 * authorization by `slug`/token and reads with `ignoreACL: true`. Granting `"anonymous"` an action in a class
 * ACL would leak far more than intended; see the note on `BaseMailboxRoute` for the incident that documents.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface BookingType extends BaseEntity {
    /** The unique identifier of the `Mailbox` that owns this booking type. Managing it (create/list/update/
     * delete) is permission-checked against this mailbox's `AccessControlList`, the same as every other
     * mailbox-scoped child entity - see the architecture note on `Message.mailboxUid`. */
    mailboxUid: string;

    /** The unique identifier of the `Folder` (of type `CALENDAR`) bookings are written into, and whose existing
     * events are treated as busy time. */
    calendarFolderUid: string;

    /** The globally unique, URL-safe public identifier for this booking type (the `intro-call` in
     * `/bookings/intro-call`). Normalized to lowercase and collision-checked on create/update. Unlike `Domain`,
     * whose `uid` *is* its name, this is an ordinary mutable indexed field - `RepoUtils.update()` requires
     * `obj.uid === existing.uid`, so a uid-derived slug could never be renamed. */
    slug: string;

    /** The public-facing name of the offering, e.g. "30 Minute Intro Call". */
    name: string;

    description?: string;

    /** The host's name as shown to an anonymous booker. Denormalized onto this entity deliberately: an
     * unauthenticated caller cannot read the owning `Mailbox` or `Folder` record to look it up, which is the
     * exact remedy `BaseFolderRoute`'s doc comment prescribes for this situation. */
    hostDisplayName: string;

    /** How long a single booking lasts, in minutes. */
    durationMinutes: number;

    /** The IANA timezone identifier `availability`/`dateOverrides` are authored in. Validated on write by
     * round-tripping it through `convertLocalToUtc()`, which returns `undefined` for a name ICU doesn't know. */
    timezone: string;

    /** The recurring weekly windows this type can be booked in. */
    availability: BookingAvailabilityWindow[];

    /** Per-date replacements for `availability`. A date present here wins outright for that date. */
    dateOverrides: BookingDateOverride[];

    /** How far apart consecutive candidate slot start times are, in minutes. Defaults to `durationMinutes`
     * (back-to-back slots) when unset. */
    slotIntervalMinutes?: number;

    /** Padding kept clear immediately before a booking, in minutes - a slot whose padded window collides with
     * existing busy time is not offered. */
    bufferBeforeMinutes: number;

    /** Padding kept clear immediately after a booking, in minutes. */
    bufferAfterMinutes: number;

    /** The minimum lead time, in minutes, between now and a bookable slot's start. */
    minimumNoticeMinutes: number;

    /** How far into the future slots are offered, in days from now. */
    bookingWindowDays: number;

    /** The maximum number of non-cancelled bookings allowed on any single local date. Unset means unlimited.
     * This is an availability control, NOT abuse protection - see `BaseBookingRoute`'s doc comment. */
    maxPerDay?: number;

    /** When `true`, a new booking lands as `PENDING` with a `TENTATIVE` calendar event for the host to confirm,
     * rather than auto-confirming. */
    requiresApproval: boolean;

    /** When `false`, the public endpoints behave as though this booking type does not exist (404). */
    enabled: boolean;
}

export enum BookingStatus {
    PENDING = "pending",
    CONFIRMED = "confirmed",
    CANCELLED = "cancelled",
}

/**
 * A single appointment booked against a `BookingType` by an anonymous visitor. Pairs 1:1 with a real
 * `CalendarEvent` in the host's calendar (`calendarEventUid`) - the event is what the host and every connected
 * client see, while this row carries the booker-facing details and the `manageToken` that lets the booker come
 * back later to cancel or reschedule without ever having an account.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface Booking extends BaseEntity {
    /** The unique identifier of the `BookingType` this was booked against. */
    bookingTypeUid: string;

    /** The unique identifier of the host `Mailbox`, denormalized from the booking type so the host's bookings
     * can be listed without a join. */
    mailboxUid: string;

    /** The unique identifier of the `Folder` (of type `CALENDAR`) holding `calendarEventUid`. */
    folderUid: string;

    /** The unique identifier of the `CalendarEvent` created for this booking. */
    calendarEventUid: string;

    bookerName: string;

    /** The booker's email address, normalized to lowercase. Where the confirmation and the manage link are sent. */
    bookerEmail: string;

    bookerNotes?: string;

    /** The IANA timezone the booker selected their slot in, recorded purely so the host can see it. Never used
     * for any scheduling math - the slot itself is stored as absolute instants. */
    bookerTimezone?: string;

    startDate: Date;

    endDate: Date;

    status: BookingStatus;

    /** The unguessable token embedded in the booker's manage link, minted server-side (32 random bytes) and
     * immutable thereafter. This is the booker's ONLY credential; unlike `CalendarShareLink.token` it is not an
     * `ACLRecord` on anything, since `BaseBookingRoute` resolves it directly rather than going through the ACL
     * system. It has no expiry and no GC job - see that route's documented limitations. */
    manageToken: string;

    cancelledAt?: Date;
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

    /** The unique identifier of the `TaskList` this task is a member of, if any (undefined = the default flat
     * task list backed directly by this task's `folderUid`). Same shape/purpose as `Contact.contactListUid`. */
    taskListUid?: string;

    /** Whether the caller has manually added this task to their curated "My Day" working set — not derived from
     * `dueDate`, since a task with no due date (or a future one) can still be added to today's list. Absent/
     * `undefined` is equivalent to `false` — optional rather than a defaulted required field so that adding
     * this column never requires backfilling a NOT NULL value onto every pre-existing row in a SQL deployment. */
    myDay?: boolean;

    /** The unique identifier of the `User` this task has been assigned to, if any. */
    assignedTo?: string;
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
    TRANSPORT_RULE = "transport_rule",
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

    /** Set by `BaseMailIngestRoute.deliver()` when a `TransportRule`'s `quarantine` action matched this
     * message - `ScanQueueJob` quarantines this entry unconditionally (using this as `QuarantineEntry.reason`)
     * rather than deriving a verdict from AV/spam scanning alone, though scanning still runs normally so a
     * policy-quarantined message still gets a real `ScanResult` for the reviewer. `undefined` for an entry
     * whose eventual verdict is decided purely by `resolveDeliveryVerdict()`. */
    quarantineReason?: QuarantineReason;
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

    /** The EAS `Class` (`"Email"`, `"Contacts"`, ...) most recently synced for a folder, keyed by `Folder.uid` -
     * lets a `Sync` request omit `Class` after its first request for a collection, per [MS-ASCMD], without the
     * server losing track of which entity type that collection holds. */
    folderCollectionClasses: Record<string, string>;

    lastSyncAt?: Date;

    provisioned: boolean;

    /** `true` once an administrator has requested this device be remotely wiped (MS-ASPROV `RemoteWipe`). Set
     * back to `false` once the device acknowledges the wipe. */
    remoteWipeRequested?: boolean;

    /** `true` if the pending/most recent remote wipe request was scoped to this account only (vs. a full device
     * wipe) - recorded for administrative record-keeping; the wire directive sent to the device is the same
     * either way in this library's pragmatic subset. */
    remoteWipeAccountOnly?: boolean;

    /** When the device most recently acknowledged a remote wipe request. */
    remoteWipeAcknowledgedAt?: Date;
}

/**
 * Internal bookkeeping row (not client-manageable - no CRUD route exists for this entity) used by
 * `ScanQueueJob` to throttle automatic (out-of-office) replies: at most one reply is sent to a given sender per
 * `mailboxUid` within a rolling `mail:oof:resuppress_after_hours` window, to avoid a reply storm against a busy
 * sender. A deliberate, documented simplification of Exchange's own per-OOF-period suppression (this library has
 * no "OOF was turned on at" timestamp to reset a cache against cleanly) in favor of a simple rolling window.
 * Purged once stale by `OofReplySuppressionCleanupJob`.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface OofReplySuppression extends BaseEntity {
    mailboxUid: string;

    senderAddress: string;

    lastRepliedAt: Date;
}
