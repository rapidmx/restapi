///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The route audit table: EVERY route class this package registers, classified by what it serves, so a route added later
// can't slip past the "no role reads another user's mail" rule. `mailAccessGuard.test.ts` fails when a concrete route
// class is missing from here, when a `mailbox` one isn't exercised by `mailAccessMatrixSuite.ts`, or when a route source
// file reaches for a trusted role without being listed in `TRUSTED_ROLE_USES`. The same table is written up in
// `.claude/NOTES.md` (2026-09-21).
//
//   mailbox      Scoped to a mailbox: ownership or an explicit ACL grant is required, a trusted role is no grant.
//   user         Scoped to the calling user's own row; there is no way to name another user's.
//   compliance   Designed to cross mailboxes: its own dedicated authorization (escrow holders, matters, explicit request
//                workflows) and audit. Listed for JP's decision - see NOTES.
//   admin        Administers the platform (policies, domains, plugins, ...); serves no mail content.
//   public       Anonymous or machine-authenticated (MTA secret): serves no user's private data.

export type RouteKind = "mailbox" | "user" | "compliance" | "admin" | "public";

export interface RouteRow {
    kind: RouteKind;
    /** The `Base*Route` class its logic lives in (`ScopedChildRoute`'s children name `BaseScopedChildRoute`). */
    base: string;
    /** How access is decided - one line. */
    gate: string;
}

/** Keyed by the concrete route class name without its backend suffix (`MailboxRoute` for `MailboxRouteMongo`/`MailboxRouteSQL`). */
export const ROUTE_TABLE: Record<string, RouteRow> = {
    // --- mailbox-scoped -------------------------------------------------------------------------------------------
    MailboxRoute: { kind: "mailbox", base: "BaseMailboxRoute", gate: "own/ACL mailboxes for everyone; ?scope=admin metadata for trusted+elevated, audited; GET /leftover (uids and counts of deleted mailboxes' data) and DELETE ?erase=true for trusted+elevated only" },
    FolderRoute: { kind: "mailbox", base: "BaseFolderRoute", gate: "hasMailAccess on the mailbox/folder; inherited handlers get mailUser()" },
    MessageRoute: { kind: "mailbox", base: "BaseMessageRoute", gate: "hasMailAccess on the folder/mailbox (BaseScopedChildRoute)" },
    AttachmentRoute: { kind: "mailbox", base: "BaseAttachmentRoute", gate: "hasMailAccess on the message's folder" },
    CalendarEventRoute: { kind: "mailbox", base: "BaseCalendarEventRoute", gate: "hasMailAccess on the folder; ?shareToken= for a share link" },
    CalendarShareLinkRoute: { kind: "mailbox", base: "BaseCalendarShareLinkRoute", gate: "hasMailAccess on the folder" },
    ContactRoute: { kind: "mailbox", base: "BaseContactRoute", gate: "hasMailAccess on the folder" },
    ContactListRoute: { kind: "mailbox", base: "BaseScopedChildRoute", gate: "hasMailAccess on the mailbox" },
    NoteRoute: { kind: "mailbox", base: "BaseScopedChildRoute", gate: "hasMailAccess on the folder" },
    TaskRoute: { kind: "mailbox", base: "BaseScopedChildRoute", gate: "hasMailAccess on the folder" },
    TaskListRoute: { kind: "mailbox", base: "BaseScopedChildRoute", gate: "hasMailAccess on the mailbox" },
    LabelRoute: { kind: "mailbox", base: "BaseLabelRoute", gate: "hasMailAccess on the mailbox" },
    MailSignatureRoute: { kind: "mailbox", base: "BaseScopedChildRoute", gate: "hasMailAccess on the mailbox" },
    MailFilterRuleRoute: { kind: "mailbox", base: "BaseMailFilterRuleRoute", gate: "hasMailAccess on the mailbox" },
    FocusedInboxOverrideRoute: { kind: "mailbox", base: "BaseFocusedInboxOverrideRoute", gate: "hasMailAccess on the mailbox" },
    QuarantineRoute: { kind: "mailbox", base: "BaseQuarantineRoute", gate: "hasMailAccess; ?scope=admin (trusted+elevated) reviews and releases, audited" },
    IngestQueueRoute: { kind: "mailbox", base: "BaseScopedChildRoute", gate: "hasMailAccess; ?scope=admin (trusted+elevated) reviews, audited" },
    MailboxAccessRoute: { kind: "mailbox", base: "BaseMailboxAccessRoute", gate: "owner/manager; administrator (trusted+elevated) lists/revokes any, grants on ownerless only, audited" },
    SearchRoute: { kind: "mailbox", base: "BaseSearchRoute", gate: "hasMailAccess READ on the searched mailbox (default: the caller's own)" },
    KeyVaultRoute: { kind: "mailbox", base: "BaseKeyVaultRoute", gate: "owner or explicit ACL record only (getRecord, no trusted bypass); writes owner-only" },
    KeyLookupRoute: { kind: "mailbox", base: "BaseKeyLookupRoute", gate: "hasMailAccess UPDATE on the mailbox" },
    DirectoryRoute: { kind: "mailbox", base: "BaseDirectoryRoute", gate: "org address book: any mailbox owner or trusted; contact suggestions: own + hasMailAccess READ mailboxes" },
    MailboxImportRequestRoute: { kind: "mailbox", base: "BaseMailboxImportRoute", gate: "own mailbox, or hasMailAccess CREATE on ?mailboxUid; requests visible to requester/owner/trusted (metadata)" },
    // --- per-user --------------------------------------------------------------------------------------------------
    AppearanceRoute: { kind: "user", base: "BaseAppearanceRoute", gate: "the caller's own row only (uid = 'appearance:<user uid>'); no trusted path" },
    // --- designed to cross mailboxes (JP decides) --------------------------------------------------------------------
    DataExportRequestRoute: { kind: "compliance", base: "BaseDataExportRoute", gate: "trusted may export/download ANY mailbox (data-subject request); requests and non-owner downloads audited" },
    DataSubjectErasureRequestRoute: { kind: "compliance", base: "BaseDataSubjectErasureRequestRoute", gate: "trusted approves/denies erasure of any mailbox; POST /leftover (trusted+elevated) files an approved erasure of a DELETED mailbox's data - never of an existing mailbox; exposes no content; audited" },
    EscrowAccessRequestRoute: { kind: "compliance", base: "BaseEscrowAccessRequestRoute", gate: "escrow-scope holders only (never a trusted role), dual control, hash-chained escrow audit" },
    EscrowAuditLogRoute: { kind: "compliance", base: "BaseEscrowAuditLogRoute", gate: "trusted reads the chained escrow audit (metadata); holders see their matters'" },
    EscrowScopeRoute: { kind: "compliance", base: "BaseEscrowScopeRoute", gate: "trusted configures scopes (holders, keys); no mail content" },
    MatterRoute: { kind: "compliance", base: "BaseMatterRoute", gate: "escrow-scope holders create/close matters (never a trusted role); legal hold; audited" },
    MatterSearchRoute: { kind: "compliance", base: "BaseMatterSearchRoute", gate: "escrow-scope holders only; searches custodian mailboxes assigned to the scope, within the matter's date range" },
    MatterExportRequestRoute: { kind: "compliance", base: "BaseMatterExportRequestRoute", gate: "escrow-scope holders only; hash-chained escrow audit" },
    // --- platform administration (no mail content) -------------------------------------------------------------------
    AuditLogRoute: { kind: "admin", base: "BaseAuditLogRoute", gate: "trusted reads the audit log; nobody writes it through the API" },
    BrandingRoute: { kind: "admin", base: "BaseBrandingRoute", gate: "public read of the branding; trusted writes, audited" },
    DistributionListRoute: { kind: "admin", base: "BaseDistributionListRoute", gate: "trusted manages org lists; audited" },
    DomainRoute: { kind: "admin", base: "BaseDomainRoute", gate: "trusted manages domains; audited" },
    EncryptionPolicyRoute: { kind: "admin", base: "BaseEncryptionPolicyRoute", gate: "trusted; audited" },
    MailboxPolicyRoute: { kind: "admin", base: "BaseMailboxPolicyRoute", gate: "trusted; audited" },
    PluginRoute: { kind: "admin", base: "BasePluginRoute", gate: "trusted; audited" },
    RetentionPolicyRoute: { kind: "admin", base: "BaseRetentionPolicyRoute", gate: "trusted; audited" },
    SetupRoute: { kind: "admin", base: "BaseSetupRoute", gate: "trusted (first-run wizard); audited" },
    SigningEnrollmentAdminRoute: { kind: "admin", base: "BaseSigningEnrollmentAdminRoute", gate: "trusted AND elevated (assertAdminScope) on every call; request metadata, CSRs and issued certificates only - never a key, and nothing of any mailbox; audited" },
    SigningEnrollmentInfoRoute: { kind: "admin", base: "BaseSigningEnrollmentInfoRoute", gate: "any signed-in user reads which backend issues signing certificates and how it is doing; nothing per mailbox or per request" },
    TransportRuleRoute: { kind: "admin", base: "BaseTransportRuleRoute", gate: "trusted manages org transport rules; audited" },
    // --- public / machine ------------------------------------------------------------------------------------------
    KeyDiscoveryRoute: { kind: "public", base: "BaseKeyDiscoveryRoute", gate: "anonymous, rate limited: the published public keys of a mailbox, by hash" },
    MailIngestRoute: { kind: "public", base: "BaseMailIngestRoute", gate: "the MTA's shared bearer secret; not a user endpoint" },
    // --- push ------------------------------------------------------------------------------------------------------
    MailPushRoute: { kind: "mailbox", base: "MailPushRoute", gate: "a channel is the caller's own uid or a mailbox/folder uid the caller holds READ on as themselves (roles stripped)" },
};

/** Route classes that live in the `server` package (`server/src/routes`, `server/src/{mongo,sql}/routes`) - listed here so
 * the audit is in one place; `server/test/routes/mailAccessRoutes.test.ts` checks them. */
export const SERVER_ROUTE_TABLE: Record<string, RouteRow> = {
    MessageRawContentRoute: { kind: "mailbox", base: "BaseMessageRawContentRoute", gate: "hasMailAccess READ on the message's folder; non-owner reads audited" },
    MailComposeRoute: { kind: "mailbox", base: "BaseMailComposeRoute", gate: "hasMailAccess UPDATE on the draft's folder" },
    EscrowInfoRoute: { kind: "mailbox", base: "BaseEscrowInfoRoute", gate: "owner or explicit ACL record only (getRecord, no trusted bypass)" },
    PushRoute: { kind: "mailbox", base: "MailPushRoute", gate: "restapi's MailPushRoute: own uid or a mailbox/folder uid the caller holds READ on as themselves (roles stripped)" },
    ACLRoute: { kind: "admin", base: "BaseGuardedACLRoute", gate: "trusted for non-mail ACLs; ACLs governing mail (mailbox, folder, Mailbox class ACL) need FULL as the caller themselves" },
    AdminConsoleRoute: { kind: "admin", base: "-", gate: "renders the admin console page for trusted callers; serves no data" },
    AdminRoute: { kind: "admin", base: "BaseAdminRoute", gate: "framework admin endpoints (@RequiresTrustedRole)" },
    EscrowConsoleRoute: { kind: "admin", base: "-", gate: "renders the escrow console page; serves no data" },
    GiphySearchRoute: { kind: "user", base: "BaseGiphySearchRoute", gate: "proxies a GIF search for a signed-in user; no mailbox data" },
    MetricsRoute: { kind: "admin", base: "-", gate: "Prometheus metrics; token-gated" },
    OpenAPIRoute: { kind: "public", base: "-", gate: "API description" },
    PublicPageRoute: { kind: "public", base: "-", gate: "serves the public web pages" },
    StaticAssetRoute: { kind: "public", base: "BaseStaticAssetRoute", gate: "serves static files" },
    StatusRoute: { kind: "public", base: "BaseReadinessStatusRoute", gate: "readiness" },
    wwwRoute: { kind: "user", base: "-", gate: "renders the web client's page shells with the caller's own identity" },
};

/** Every source file under `src/routes` that mentions a trusted role (`hasRoles`/`isTrusted(`), with why that doesn't widen
 * access to a mailbox: each one runs only after the caller's access to the mailbox has been decided by `hasMailAccess()`, or
 * concerns something that isn't a mailbox. A new file using a trusted role has to be added here - and that means someone
 * decided it. */
export const TRUSTED_ROLE_USES: Record<string, string> = {
    "BaseCalendarEventRoute.ts": "free/busy lookup: a trusted caller who owns no mailbox is told `restricted` rather than `unknown` about a mailbox they may not see, as the directory lists it to them - never a grant",
    "BaseDataExportRoute.ts": "compliance: a trusted caller may request/download any mailbox's export - by design, audited",
    "BaseDataSubjectErasureRequestRoute.ts": "compliance: trusted approves erasure; exposes no mail content",
    "BaseDirectoryRoute.ts": "the org address book (not private data) may be searched by a trusted caller who owns no mailbox",
    "BaseEscrowAuditLogRoute.ts": "compliance: trusted reads the escrow audit metadata",
    "BaseFolderRoute.ts": "trusted may set server-managed folder fields (counters) - after hasMailAccess has passed",
    "BaseMailboxAccessRoute.ts": "the explicit administrator Sharing action (audited), and 'nobody but a trusted role changes their own record'",
    "BaseMailboxImportRoute.ts": "request metadata visible to trusted callers; importing needs hasMailAccess CREATE",
    "BaseMailboxRoute.ts": "administration of mailbox rows: trusted-only fields (owner, quota), admin scope - never a grant on the mailbox",
    "BaseMessageRoute.ts": "trusted-only field privileges (Drafts-only send, dates) - after hasMailAccess has passed",
    "BaseScopedChildRoute.ts": "trusted-only writes and server-managed fields - after hasMailAccess; admin scope on quarantine/ingest queue",
};
