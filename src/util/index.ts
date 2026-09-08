///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/**
 * Public, backend-agnostic REST-layer helpers shared across this library's own routes and useful to any
 * downstream protocol package (`@rapidmx/activesync`, `@rapidmx/mapi`, `@rapidmx/autodiscover`) that needs to
 * resolve a caller's mailbox, walk a folder tree, send a composed message through the scan/relay pipeline,
 * evaluate mail filter rules or resolve a mailbox's default signature/OOF state, or soft-delete a
 * `RecoverableBaseEntity` with a correctly bumped watermark. `OptionalDeps.ts`'s `importOptional()` is
 * deliberately not re-exported here - it's an internal helper for this library's own optional peer dependencies
 * (PDF/DOCX extraction, OpenSearch), not something a protocol package needs.
 */
export * from "./AddressUtils.js";
export * from "./AutoReplyUtils.js";
export * from "./DistributionListUtils.js";
export * from "./FolderUtils.js";
export * from "./IcsUtils.js";
export * from "./MailFilterUtils.js";
export * from "./MailSendUtils.js";
export * from "./MailSignatureUtils.js";
export * from "./MailboxScopeUtils.js";
export * from "./MimeHeaderUtils.js";
export * from "./OofUtils.js";
export * from "./RecoverableRepoUtils.js";
export * from "./TransportRuleUtils.js";
