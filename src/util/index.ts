///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/**
 * Public, backend-agnostic REST-layer helpers shared across this library's own routes and useful to any
 * downstream protocol package (`@rapidmx/activesync-plugin`, `@rapidmx/mapi-plugin`, `@rapidmx/autodiscover-plugin`) that needs to
 * resolve a caller's mailbox, walk a folder tree, send a composed message through the scan/relay pipeline,
 * evaluate mail filter rules or resolve a mailbox's default signature/OOF state, or soft-delete a
 * `RecoverableBaseEntity` with a correctly bumped watermark. `OptionalDeps.ts`'s `importOptional()` is
 * deliberately not re-exported here - it's an internal helper for this library's own optional peer dependencies
 * (PDF/DOCX extraction, OpenSearch), not something a protocol package needs.
 */
export * from "./AddressUtils.js";
export * from "./AuditLogUtils.js";
export * from "./AutoReplyUtils.js";
export * from "./BlobReferenceUtils.js";
export * from "./ClientIpUtils.js";
export * from "./ConversationUtils.js";
export * from "./DateCoercionUtils.js";
export * from "./DistributionListUtils.js";
export * from "./DraftBodyRetentionUtils.js";
export * from "./DnsSetupUtils.js";
export * from "./DomainUtils.js";
export * from "./DomainVerificationUtils.js";
export * from "./EntityUtils.js";
export * from "./FocusedInboxUtils.js";
export * from "./FolderUtils.js";
export * from "./FreeBusyUtils.js";
export * from "./IcsUtils.js";
export * from "./LegalHoldUtils.js";
export * from "./MailFilterUtils.js";
export * from "./MailSendUtils.js";
export * from "./MailboxPolicyUtils.js";
export * from "./MailSignatureUtils.js";
export * from "./MailboxScopeUtils.js";
// Keyset paging by `uid` only - the rest of `MailboxContentUtils.ts` stays internal.
export { findPagesByUid } from "./MailboxContentUtils.js";
export * from "./MimeHeaderUtils.js";
export * from "./OofUtils.js";
export * from "./RecoverableRepoUtils.js";
export * from "./RequestBodyUtils.js";
export * from "./SearchIndexUtils.js";
export * from "./TransportRuleUtils.js";
export * from "./UserUidUtils.js";
