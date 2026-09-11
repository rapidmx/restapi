# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-09-11

### Added
- Added Mailbox.alwaysRequestReceiptFederated/autoSendReceiptsFederated (both default false, matching the existing External defaults) alongside the existing Internal/External settings, in both SQL and Mongo backends
- Added util/DomainUtils.ts's classifyRecipientTier(), built around an injectable isFederatedPeer seam that defaults to always-false until real _rapidmx federation discovery exists (a later roadmap item) - this keeps observable behavior identical to today's internal/external classification for now while giving BaseMessageRoute.send()/maybeSendReadReceipt() and ScanQueueJob.maybeSendDeliveryReceipt() a stable three-way switch to call into
- Added util/SmimeUtils.ts's isEncryptedBody() detecting application/pkcs7-mime; smime-type=enveloped-data and multipart/encrypted from an already-parsed message, excluding opaque S/MIME signing (smime-type=signed-data) which still carries real content
- Added ScanPipelineResult.encrypted and skip sanitizedHtml/bodyPreview derivation for an encrypted body; AV/spam scoring is unaffected since both already operate on the raw buffer
- Added federation discovery infrastructure (roadmap Group B): DNS policy resolution and the remote key-endpoint HTTP client, the shared groundwork both A5's real federated-peer detection and the eventual discovery-protocol routes build on
- Added util/FederationUtils.ts's resolveFederationPolicy(), resolving a domain's _rapidmx TXT record (v=RMXv1; id=...; host=...;), structurally mirroring DomainVerificationUtils.checkDomainVerification()'s never-throws/chunk-rejoin conventions, caching both positive and negative results via @rapidrest/core's SimpleStore (a plain MemoryStore, no new cache utility needed)
- Added util/KeyDiscoveryClient.ts's fetchRemoteKeys(), fetching a peer's GET /.well-known/rapidmx/keys/:hash endpoint and honoring ETag/Cache-Control/304 against its own separate SimpleStore instance, kept distinct from the DNS-policy cache per the spec's explicit separation of per-user key freshness from domain-policy caching; TLS certificate/hostname verification needs no extra code since Node's fetch() already refuses a certificate that doesn't chain to a trusted root or cover the hostname; includes a hand-rolled z-base32 encoder (computeKeyDiscoveryHash()) since no dependency exists for it and there is exactly one call site
- Added the shared PublicKey/EncryptionPreference/KeyDiscoveryResponse types to models/types.ts, pulled forward from the data-model group since the discovery client's return type needs them
- Added a compact nav-header icon to Branding, independent of the full logo
- Added util/DomainUtils.ts's createFederatedPeerCheck(dnsResolver), bridging classifyRecipientTier()'s FederatedPeerCheck seam to FederationUtils.resolveFederationPolicy() - a federated peer is any domain publishing a valid _rapidmx TXT record
- Added @Inject("DnsResolver") to BaseMessageRoute.ts and ScanQueueJob.ts (the same DI token BaseDomainRoute/DomainVerificationJob already register/consume, so every deployment and test environment already has one) and pass a real check into every classifyRecipientTier() call site instead of relying on the default stub
- Added real end-to-end tests (SQL + Mongo, both the send()-time request-attachment path and ScanQueueJob's delivery-receipt auto-send path) proving a federated peer registered via StaticDnsResolver actually activates the Federated tier, not just that the stub correctly does nothing - caught and fixed a genuine test-authoring bug in the process: envelopeTo in send() comes from Message.recipients (a structured field), not parsed from the raw MIME blob's own To: header, so both need to point at the test peer address
- Added CalendarEvent.encrypted provenance flag and wire it through ScanQueueJob's iTIP processing (roadmap items I2/I3 - Derived Entities inheritance)
- Added EncryptionPolicy singleton settings entity + route (roadmap Group H1) - the system-wide, per-recipient-tier encryption policy from specs/end-to-end_encryption.md's "Encryption Policy States" section
- Added EncryptionCertificateAuthority abstraction (F1-F3): pluggable internal-CA interface, mandatory NullEncryptionCertificateAuthority default, and LocalX509CertificateAuthority zero-infrastructure implementation
- Added OpenBaoPkiCertificateAuthority (F3b): recommended production EncryptionCertificateAuthority backend
- Added an optional IssuedCertificate.serialNumber field (populated by both LocalX509CertificateAuthority and this new adapter) - generic, useful X.509 metadata, additive to the interface introduced in the previous commit
- Added SigningCertificateEnrollment abstraction (F4): pluggable public-CA enrollment interface, mandatory Null default, and CA-agnostic ManualSigningCertificateEnrollment implementation
- Added Key/Keyring data model (Group C): WrappedPrivateKey/MasterKeyWrap/KeyVault types, Mailbox/Contact extensions, and a Contact write-protection fix
- Added WrappedPrivateKey and MasterKeyWrap (with an escrowScopeId seed field for the still-deferred Escrow Scoping follow-up) alongside the already-shipped PublicKey/EncryptionPreference types (C1)
- Added Mailbox.encryptPreference/keys (required, safe universal defaults) and keyDiscoveryHash (optional, deliberately NOT backfilled with a shared default under a uniqueness constraint - that would collide across every pre-existing row the moment a second one is saved, the same class of bug as this session's earlier alwaysRequestReceiptFederated NOT NULL incident); BaseMailboxRoute now computes/recomputes keyDiscoveryHash alongside primarySmtpAddress on create and update (C2)
- Added Contact.encryptPreference/keys/keysFirstSeen/lastMessageSeen/keyConflict, discovery-managed fields that trust-on-first-use pinning and the spec's Anti-Downgrade rule depend on never being writable via an ordinary client edit; Contact previously had no dedicated Base*Route class (unlike every other folder-scoped entity) and used BaseScopedChildRoute's generic create()/update() directly, which would have let any caller PATCH these fields freely - fixed by introducing BaseContactRoute, which rejects (400) any request attempting to set them directly (C3)
- Added the KeyVault entity (own table/collection, keyed by mailboxUid, no per-record ACL) holding wrappedKeys/masterKeyWraps, deliberately separate from Mailbox so private key material can never leak via an ordinary Mailbox fetch - no route yet, Group D wires up GET /mailbox/:id/keyvault and enrollment against it (C4)
- Added Key Vault Endpoints (Group D): GET/enroll/wrap-CRUD/re-key under /mailbox/:id/keyvault
- Added GET /mailbox/:id/keyvault (D1), deliberately checking the owning mailbox's own AccessControlList directly via ACLUtils.getRecord() rather than hasPermission(), since the latter has an unconditional "trusted users always have permission" bypass (confirmed by reading ACLUtils.js) that would give any admin blanket read access to every mailbox's private key material - a system admin gets 403 unless they are the mailbox owner or hold an explicit delegate ACLRecord
- Added POST /mailbox/:id/keyvault/keys (D2) to enroll a new key: for useType "encrypt" it calls the injected EncryptionCertificateAuthority.issue() itself against the caller's CSR, wiring up Group F's abstraction as anticipated; for useType "sign" it validates an already-issued certificate instead, since signing-cert enrollment against a public CA is a separate, asynchronous flow (SigningCertificateEnrollment) that has already completed by the time this call is made; the new PublicKey (Mailbox.keys) and WrappedPrivateKey/initial MasterKeyWraps (KeyVault) are written atomically via @Transactional()
- Added POST/DELETE .../keyvault/wraps (D3) to add or remove one MasterKeyWrap independent of key enrollment, identified by method + optional methodId
- Added PUT .../keyvault/rekey (D4), an atomic full replacement of wrappedKeys/masterKeyWraps/keys and the only real revocation mechanism for a captured wrap
- Added public key discovery endpoint (E1): GET /.well-known/rapidmx/keys/:hash
- Added server-side Discovery proxy (E2): GET /mailbox/:id/keys/lookup?addr= and util/KeyringUtils.ts
- Added util/KeyringUtils.ts's applyDiscoveredKeys(), implementing the Trust Model in one shared place: TOFU-pins the first key seen per useType; on a later different key, retains the pinned one and records Contact.keyConflict unless the pinned key is expired/revoked and the new one shares its issuer (sameIssuingCa(), an issuer-DN heuristic, not full chain verification, documented as such); and never lets a lookup that finds nothing regress keys/encryptPreference already on file (Anti-Downgrade) - this same function is designed to be reused by Group E3's inbound RapidMX-Key header processing, which has a KeyDiscoveryResponse-shaped payload already in hand rather than needing discoverAndMergeKeys()'s own DNS/HTTP lookup
- Added inbound RapidMX-Key header processing (E3): AuthenticationResultsUtils, RapidMxKeyHeaderUtils, wired into ScanQueueJob
- Added util/AuthenticationResultsUtils.ts's hasAlignedPassingDkim() as new territory for this codebase - nothing parses Authentication-Results today, since this app otherwise trusts whatever the upstream MTA hands it - as the specific gate specs/end-to-end_encryption.md requires before an inbound RapidMX-Key header may be acted on ("Receiving servers MUST verify DKIM before acting on the header and MUST treat an unverified header as absent"), failing closed on anything short of an aligned dkim=pass result
- Added util/RapidMxKeyHeaderUtils.ts's parseRapidMxKeyHeader(), implementing the header's own processing rules verbatim: exactly one header (all copies ignored otherwise), addr must match From, unknown non-_-prefixed attributes invalidate the whole header, keydata must parse as a real certificate; the signing certificate is never carried here per the spec, so the resulting PublicKey.useType is always "encrypt"
- Added extractHeaders() (plural) to MimeHeaderUtils.ts alongside the existing extractHeader(), needed since the ">1 RapidMX-Key header" and "Authentication-Results may repeat per hop" rules both require seeing every occurrence, not just the first
- Added outbound RapidMX-Key header attachment (E4)
- Added RapidMxKeyHeaderUtils.buildRapidMxKeyHeader(), the inverse of the existing parseRapidMxKeyHeader() used by E3's inbound processing
- Added Rotation Notification MDN extension fields (E5)
- Added optional rotatedKeyFingerprint/policyId fields to ReceiptUtils's build/parse functions, carried as RFC 8098 extension fields (X-RapidMX-Key-Fingerprint/X-RapidMX-Policy-Id) in the message/disposition-notification part - per spec these are a cache-invalidation hint only, never a trusted key source
- Added a new maybeRefreshRotatedKey(), called by processReceipt() whenever either extension field is present, which re-runs real Discovery (KeyringUtils.discoverAndMergeKeys()) against the authoritative endpoint rather than trusting the MDN's own claimed value - an MDN is only hop-authenticated, so installing its claimed fingerprint directly would let a forged MDN force a key change
- Added E2E feature specs
- Added DKIM+alignment checking, Disposition-Notification-To must-equal-From, and replay/uniqueness protection to MDN/receipt verification
- Added SSRF hardening in KeyDiscoveryClient: hostname validation, IP-literal rejection, redirect: "error", bounded-size streamed reads
- Added cert.checkEmail() validation against the mailbox address for signing-cert enrollment
- Added basicConstraints/keyUsage to leaf certs and build the subject DN structurally (no injection) in the PKI layer
- Added a regression test to ContactRoute.test.ts proving BaseContactRoute.create() actually rejects an empty displayName (400) - @Validate metadata cascades through every override via prototype-chain inheritance without needing to be redeclared, which a prior audit incorrectly flagged as broken
- Added validation-rejection integration tests across route classes
- Added a matching create-rejection test for both SQL and Mongo backends to every genuine gap found: TransportRule, ContactList, MailFilterRule, MailSignature, Note, TaskList, Task, Folder, CalendarShareLink, DistributionList
- Added validateWrappedPrivateKey() plus MAX_ENROLLED_KEYS/MAX_MASTER_KEY_WRAPS bounds, closing an unbounded-storage-growth DoS from wrappedKey/wrappedKeys having no field-shape validation at all
- Added a real HTTP/DB-backed regression test proving the specific failure scenario for every fix above, for both SQL and Mongo backends where applicable
- Added search operator grammar, Tier 3 candidates, and schema per specs/search.md - the mechanical, unambiguous server-side portion of the doc (companion to end-to-end_encryption.md's deferred search design), groups J/K/L/M of the scoping breakdown; client-side work (local FTS5 index, progressive-results UI, client-side re-scoring/merge) is out of scope for this repo
- Added folderUid, flags[], hasAttachments to SearchDocument, powering the in:/is:/has:attachment operators
- Added SearchDocument.metadataOnly / SearchResult.metadataOnly, set by SearchIndexJob when a message is encrypted (subject/body/attachmentText intentionally excluded), so a client can tell a participants-only score apart from a full-content one
- Added structured filter fields to SearchQuery (from/to/cc/subject/hasAttachment/before/after/folderUid/flags) per §14's query operator grammar - already parsed by the caller per the spec ("parsing happens once, client-side"), not raw operator text; all three providers (Mongo/Postgres/OpenSearch) translate these into real filter predicates
- Added CandidateQuery/CandidateResultPage types and SearchProvider.candidates(), implemented by all three providers, returning identifiers only ranked on server-visible metadata (participants/dates/folder/flags), never content, per §6/§12's Tier 3 design
- Added GET /search/candidates to BaseSearchRoute for the new Tier 3 candidate query
- Added CalendarEvent encryption provenance and skip auto-send for encrypted invites
- Added MTA impl for AWS SES

### Changed
- Update NOTES.md noting the 0.4.0 publish and that @rapidmx/server has dropped its yarn patch for a plain semver dependency on it
- Refine delivery/read receipts to a three-tier same-organisation/federated-peer/external scoping model instead of the previous binary internal/external one, per specs/end-to-end_encryption.md's Scoping Principle (receipts are a disclosing capability and MUST default to same-organisation only, not lumping a federated peer in with plain external correspondents)
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Stop feeding S/MIME-encrypted mail's ciphertext into server-side pipelines that assumed a readable body - a standing correctness gap independent of the rest of the E2E encryption feature, since any externally-received encrypted mail already hits these code paths today
- Stop indexing body/attachment text in SearchIndexJob for an encrypted message (subject/participants/dates are unaffected - they're outer RFC 5322 headers, never encrypted by CMS EnvelopedData)
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Note (not silently resolved): the spec's own worked example for the discovery hash is SHA-1-length (32 z-base32 chars) while its prose and formula both say SHA-256 (which produces 52) - implemented per the twice-repeated explicit SHA-256 statements, documented in computeKeyDiscoveryHash()'s doc comment for whoever corrects the spec's example
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Split the single logoUrl asset into a full logo (watermark/sign-in-style use) and a separate, independently configurable iconUrl for compact nav-header use, mirroring the existing logo upload/URL/delete plumbing end to end: BrandingMongo/BrandingSQL gain iconUrl/iconBlobKey/iconContentType columns, and BaseBrandingRoute gains POST/GET/DELETE /branding/icon mirroring the logo endpoints, plus PUT /branding now clears and deletes an orphaned icon blob the same way it already does for the logo
- Export readPublicBranding()/fetchBrandingPropsForSSR() so a downstream server's own wwwRoute/AdminConsoleRoute-style routes can read current branding in-process (no HTTP round trip) to render it server-side on the very first byte of the response, needed by rapidmx/server's own SSR title/favicon/stylesheet work
- Bump to 0.5.0
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Wire real federation detection into the three-tier receipt classification (roadmap item A5), replacing the always-false stub A2 shipped with - closes out Group A now that Group B's resolveFederationPolicy() exists
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Persist Message.encrypted (a prerequisite Group G's ScanPipelineResult.encrypted never made durable) and use it for roadmap item I1: stop AttachmentExtractionJob from running text extraction against an encrypted message's attachments
- Stamp Message.encrypted from ScanPipelineResult.encrypted at every point a Message is actually created or persisted from a scan: ScanQueueJob's two inbound delivery sites (primary + rule-copy), and BaseMessageRoute.send()'s outbound path via a new field on MailSendUtils.ScanAndRelayResult - needed because AttachmentExtractionJob and the eventual iTIP-to-CalendarEvent propagation (roadmap item I3) run well after the original ScanPipelineResult is gone, so Message itself has to carry the signal forward
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Set CalendarEvent.encrypted from the source message's own Message.encrypted (ScanQueueJob.processItipRequest()'s create branch only) when a REQUEST first materializes an event, deliberately never touched by the update branch - encryption state is sticky per the spec, preserved across every later resend/update/recurrence instance rather than recomputed from whatever message triggered that particular mutation
- Note this is currently the only part of the spec's "Derived Entities" section implemented: it's a provenance flag only, not actual field-level encryption of title/location/attachments, since today's iTIP pipeline only ever reads a text/calendar part that's already plaintext-visible to the server - a genuinely S/MIME-encrypted invitation has no such separately-visible part at all (the whole point of util/SmimeUtils.ts's isEncryptedBody() check), so this flag is set defensively for forward-compatibility rather than something the current pipeline exercises in the common case; real field-level encryption awaits the deferred client-side E2E composition/decryption work
- Defer I4 (an admin setting for automatic same-org derived-entity protection) - there is no code in this pass that ever applies derived-entity field-level encryption, so a toggle would have nothing to gate; revisit alongside the real encryption work
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Use three states (automatic/optional/prohibited), not a boolean, configured independently for encryptSameOrg/encryptFederated/encryptExternal - deliberately three because "not by default" (optional) and "not allowed" (prohibited) are materially different administrative intents a plain on/off toggle can't distinguish; defaults to "optional" for all three tiers since encryption is a protective capability with no reason to default more restrictively for federated/external than the spec's stated same-organisation default
- Model this directly on BaseBrandingRoute.ts, the one existing precedent in this codebase for a runtime-editable admin setting rather than static @Config: a singleton row at a fixed uid, the same TOCTOU-tolerant findOrCreate(), PUT gated by @RequiresTrustedRole() plus recordAuditLog(); differs from Branding in one deliberate way - GET requires authentication (any logged-in user, not just admins, since a compose UI needs this to decide what controls to offer) rather than being fully public
- Leave the separate digital-signing enable/disable toggle as a plain @Config boolean, unaffected - the spec only requires tri-state granularity for encryption, not signing
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Upgrade @rapidrest/service-core to ^2.0.0 (2.x peer range) for its query-string DSL overhaul: regex()/exists() operators, nested $or on SQL, tree-shaped query forms, sort-field validation, and fixes to MongoDB not()/ne() compilation and in()/nin()/range() type coercion
- Audit restapi's own query-DSL usage against the documented breaking changes (like() now uses glob syntax, unrecognized operators reject with 400) and confirm no impact: this codebase never uses the DSL's like() at all (the one alias-substring-match call site deliberately bypasses it with a raw TypeORM Raw() operator instead, for %/_ escaping the DSL didn't support), and every operator actually used (gte/gt/lte/lt/ne) is a recognized name unaffected by the stricter rejection rule
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Simplify BaseBookingRoute.countBookingsOnDay() back to a single range() count now that @rapidrest/service-core 2.0 fixes range()'s Date-coercion bug
- Confirm by reading the installed package's ModelUtils.coerceOperand() that both range() operands now go through the same Date-aware coercion gte()/lte() already used, resolving the exact bug the old two-subtracted-counts workaround existed for
- Keep range() inclusive on both ends (TypeORM Between() / Mongo $gte+$lte) by setting the upper bound to dayEnd minus one millisecond, preserving the exact same half-open [dayStart, dayEnd) window the workaround computed - otherwise a booking starting at exactly the next day's midnight would double-count into both days; existing maxPerDay same-day/next-day tests pass unchanged
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Mirror the DkimKeyProvider/SearchProvider pattern rather than hand-rolling certificate issuance inline: issue(identity, csr) takes a client-generated PKCS#10 CSR (proof of possession, and Vault/OpenBao-API-compatible from day one) rather than a bare public key
- Implement LocalX509CertificateAuthority to generate and persist a self-signed P-256 CA root on local disk (0600 key) using @peculiar/x509, verify each CSR's self-signature before issuing, and treat revoke() as a no-op since it has no CRL/OCSP responder - that's left to a production backend such as the still-to-come OpenBaoPkiCertificateAuthority
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Implement a thin adapter to a self-hosted OpenBao/Vault Community Edition PKI secrets engine's HTTP API - a genuinely free, self-hosted, no-contract backend, the same category as PostfixSendmailTransport being the recommended MailTransport; issue() posts the CSR to POST /v1/<mount>/sign/<role>, and revoke() identifies the certificate by serial number rather than fingerprint (Vault/OpenBao's own addressing scheme), so this class persists a small local fingerprint -> serialNumber map on issue() rather than pushing that translation onto callers
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Keep this a separate interface from EncryptionCertificateAuthority, not a variant of it - enrollment against a publicly-trusted CA is inherently asynchronous (startEnrollment()/checkStatus()), and the spec allows disabling signing certificates entirely for closed deployments, which this gives a clean "don't register a second token" story for
- Implement ManualSigningCertificateEnrollment to work with any public CA an admin chooses by hand: it validates the CSR's self-signature on startEnrollment(), persists pending enrollments to a small local JSON file (matching OpenBaoPkiCertificateAuthority's serial-map precedent from the previous commit), and verifies an uploaded certificate's public key actually matches the original CSR before accepting it via uploadCertificate()
- Defer the REST admin route for the certificate-upload step - startEnrollment() has no caller yet until Group D's key-vault enrollment endpoint exists, so a route with nothing driving traffic to it would be premature infrastructure
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Audit-log every mutating action, and add a FakeEncryptionCertificateAuthority test double (in-memory, real @peculiar/x509 issuance) since the default NullEncryptionCertificateAuthority throws
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Implement the server side of the federation discovery protocol whose client half (util/KeyDiscoveryClient.ts) shipped in Group B - unauthenticated, @RateLimit()-decorated per the spec's per-source-IP requirement (no new infrastructure, @RateLimit() already keys an independent per-IP counter)
- Look up Mailbox by its indexed keyDiscoveryHash column; the not-found and no-keys-published cases are byte-for-byte identical (200, not 404) by construction, both reducing to the same NOT_PUBLISHED_RESPONSE built from Mailbox.encryptPreference/keys' own class-level defaults, so there's no hand-maintained "make these two responses match" logic to drift out of sync
- Compute escrow from whether the mailbox's KeyVault holds any MasterKeyWrap with method "escrow" - the boolean disclosure the spec's Public Endpoint section already requires, unaffected by the deferred full Escrow Scoping work; ETag is a SHA-256 of the response body, and If-None-Match is honored with a 304
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Implement Discovery server-side as specs/end-to-end_encryption.md requires - browsers have no DNS TXT API and would hit CORS fetching an arbitrary third-party domain directly - so this endpoint performs the _rapidmx TXT lookup (util/FederationUtils.ts) and discovery-endpoint fetch (util/KeyDiscoveryClient.ts) itself and persists the result onto a Contact in the caller's own address book
- Use ordinary ACLUtils.hasPermission() (with its usual trusted-role bypass) here, deliberately unlike BaseKeyVaultRoute, since this only ever touches the address book, never private key material
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Wire this into ScanQueueJob.deliverMessage() via a new processInboundRapidMxKeyHeader() step that runs for every inbound message regardless of filtering/filing outcome, reusing Group E2's KeyringUtils.applyDiscoveredKeys() for the same TOFU/conflict/anti-downgrade merge logic; Contact.lastMessageSeen is stamped for an existing Contact even when nothing new was found, but a brand-new Contact is only created when a key was actually discovered, since lastMessageSeen alone isn't reason enough to add every random sender to the address book
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Make BaseMessageRoute.send() announce the sending mailbox's active encryption key alongside the existing Disposition-Notification-To attachment, mirroring that same pattern: only a non-revoked, non-expired "encrypt" key is ever announced (a "sign"-only key never produces a header)
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Make sendDispositionNotification() announce the reporting mailbox's own active encrypt-key fingerprint on the sending side, mirroring E4's outbound RapidMX-Key logic
- Refactor the Contact create-or-update persistence tail shared by E3's processInboundRapidMxKeyHeader() and the new maybeRefreshRotatedKey() into persistContactKeyUpdate()
- Complete Groups C/D/E of the DS/E2E encryption roadmap
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Require a configured, trusted authserv-id for Authentication-Results and fail closed when unset, closing forged-DKIM key-pinning
- Reject Mailbox.keys/keyDiscoveryHash outright on a client PUT (value-aware, so empty-array bodies still work), closing CA-bypass and discovery impersonation
- Move ContactSQL's epoch-ms columns to type "double", fixing silent mail-drop on Postgres/MySQL ("integer out of range" on the old 32-bit int mapping)
- Close escrow wraps being addable/removable/fakeable through the owner/delegate endpoints
- Scope the discovery endpoint by Host header and close its timing oracle
- Reject sending the OpenBao token over plaintext HTTP off-loopback
- Key RapidMX-Key on the From header instead of envelope-from
- Hoist N+1 domain/DNS queries in BaseMessageRoute.send() out of the per-recipient loop
- Make encrypted-attachment handling consistent between ScanQueueJob and TransportRuleUtils
- Document Escrow RBAC, CRL/OCSP infra, DKIM-oversigning automation, and DNSSEC validation as required deployment configuration in README - intentionally out of scope as net-new features, not bugs
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Apply RapidREST conventions to close several route-convention gaps found in an audit, with a regression test
- Move BaseEncryptionPolicyRoute.update()'s inline enum validation into a @Validate("validateUpdate") method, run by the framework strictly before the handler instead of inline at the top of it
- Move BaseBookingRoute.book()'s bookerName/bookerEmail shape checks into a @Validate("validateBook") method, leaving slot-availability checks that need a DB lookup in the handler as business-rule checks
- Apply @Before("rejectWrite") to BaseAuditLogRoute's create/update/delete/truncate, matching BaseACLRoute's own @Before-guard convention, with handlers keeping a defensive direct call to rejectWrite() too
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Leave AuditLogRoute (writes are blocked outright, 403 not 400), KeyDiscoveryRoute and DomainRoute.dkim (no rejectable input by design/scope), Attachment (upload path, not model-validated JSON create), DistributionListDomains (already has a real, narrowly-scoped domain-verification test), and EncryptionPolicyRoute (already has a real enum-rejection test) untouched after confirming each doesn't have a real gap
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Validate BaseKeyVaultRoute.enrollKey()'s body.masterKeyWraps instead of passing it straight to persistence unvalidated, unlike its sibling addMasterKeyWrap()/rekey() endpoints - closes the exact escrow-spoofing gap validateMasterKeyWrap() exists to prevent, just on the third call site that was missed
- Sanitize BaseAttachmentRoute's filename at upload and escape it at download, closing a Content-Disposition injection where an embedded quote could break out of the quoted value and spoof the saved filename
- Make BaseMailIngestRoute.deliver() share one blob per deliver() call for direct-mailbox recipients instead of writing a fresh copy per recipient, matching the distribution-list branch a few lines down which already does this
- Batch MailboxQuotaRecalcJob's attachment queries via the query DSL's in() operator in chunks of 100 instead of issuing one query per message with attachments (N+1)
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Split SearchDocument's participants[] into from/to[]/cc[], keeping participants[] as the union for existing free-text ranking, per §14's "Required Schema Changes"
- Wire all of the above into SearchIndexJob.buildDocument() for Message, the only entity type this job indexes today
- Switch PostgresFullTextSearchProvider from plainto_tsquery to websearch_to_tsquery for the free-text portion, and add an ALTER TABLE ADD COLUMN IF NOT EXISTS step so an upgrading deployment picks up the new columns (CREATE TABLE IF NOT EXISTS alone is a no-op against an existing table)
- Match subject: as an additional AND predicate scoped to the subject field alone, not a replacement for full-field free-text ranking
- Make BaseSearchRoute's q optional, gated on "at least one of q or a structured filter" instead of requiring q unconditionally, so a pure structured-filter query like subject:budget is valid
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Replace CalendarEvent.encrypted (a flat boolean) with encryptionOrigin: EncryptionOrigin ("none"/"derived"/"originated") per specs/search.md §3 "Provenance", so a client can explain why an event is encrypted ("received encrypted from bob@orgb.com" vs. "you chose to encrypt this") rather than collapsing both into one indistinguishable flag
- Set "derived" on create and "none" otherwise in ScanQueueJob's inbound iTIP pipeline (the only place that sets this today), continuing to never touch it on update so encryption state stays sticky per the spec; "originated" is for a client explicitly marking its own outbound invite as encrypted via ordinary CRUD, not specially protected since this field only gates indexing/send behavior, not access
- Make MeetingSchedulingJob skip composing/sending a plaintext iTIP REQUEST/CANCEL entirely for an encryptionOrigin: "originated" event, since that's the client's own responsibility end to end (compose, encrypt, send), matching this repo's scope boundary that real crypto only ever happens client-side; still stamps inviteSequenceSent/cancelNoticeSentAt so the job doesn't keep re-visiting an event it will never actually send, the same "skip the send, still mark handled" shape isRedundantOccurrenceCancel already used
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Moving Ses transport impl to this repo

### Fixed
- Fixed TransportRuleUtils.bodyContains to cleanly never-match an encrypted body's empty preview; also fixes a real bug found along the way - mailparser folds an encrypted body's own ciphertext into parsed.attachments as a synthetic node (a real EnvelopedData message has no separate visible attachment inside it), which was making hasAttachment/attachmentNameContains false-positive for encrypted mail
- Fixed AttachmentExtractionJob.processAttachment() to look up the parent message first and skip straight to stamping an empty extractedTextBlobKey (exactly like today's unsupported-MIME-type path) when it's encrypted, never handing ciphertext to ExtractorRegistry - mirrors the same encrypted-body gate already applied to ScanPipeline/SearchIndexJob/TransportRuleUtils in the earlier Group G commit
- Fixed two bugs caught during testing: EncryptionPolicySQL's PolicyState (string-literal-union) columns needed an explicit @Column({ type: "varchar" }) since TypeScript's emitDecoratorMetadata can't reflect a union type into a primitive constructor better-sqlite3 can resolve on its own (the same gotcha CalendarEventSQL.status already documents for real enums), and update() validated incoming policy values after findOrCreate() had already materialized the singleton row so a rejected (400) request still had the side effect of creating it on what should have been its first write - validation now runs first
- Fixed critical/high security findings from two adversarial reviewers auditing the E2E encryption feature (v0.4.0..HEAD) plus the service-core 2.0 migration
- Fixed sameIssuingCa() to use real signature-based self-signed detection instead of DN-string comparison, and always recompute discovered-key fingerprints from the actual certificate rather than trusting them as asserted
- Fixed rekey() to validate against already-enrolled fingerprints instead of publishing arbitrary unvalidated certificates
- Fixed the CA key generation race to be atomic
- Fixed EncryptionPolicyMongo to extend BaseMongoEntity instead of BaseEntity, a copy-paste bug that lost _id mapping and the uid/version unique index
- Fixed anti-downgrade to use the message Date instead of wall-clock
- Fixed findings from a second adversarial review pass, covering the codebase again post-convention-fixes: one reviewer focused on the E2E encryption/key-vault surface, ACL correctness, and concurrency; the other on the remaining routes, jobs, and utilities
- Fixed removeMasterKeyWrap() to reject an ambiguous request instead of silently deleting every wrap of a method when methodId was omitted and more than one existed
- Fixed MeetingSchedulingJob.sendInvites()'s unfiltered, unsorted query, which could permanently starve a genuinely new event out of the fetch window once CalendarEvent rows exceeded batch_size - added a status filter and sort: -dateModified so a new/edited event always surfaces first
- Fixed BaseMailboxRoute/BaseDistributionListRoute to re-validate a changed primarySmtpAddress on update (including the dedicated updateProperty() rename endpoint, which bypasses the @Validate dispatch pipeline entirely since it calls update() in-process) - previously let a caller silently point their own mailbox/list at another entity's address, hijacking its mail flow; now re-runs the same verified-domain/collision checks create() applies, only when the address is genuinely changing
- Fixed OpenSearchProvider.search() to populate SearchResult.snippet via a highlight block, closing a pre-existing gap the spec calls out explicitly (§1) where the interface declared the field but no provider ever set it

### Removed
- Removed @rapidrest/cli as a dep

## [0.4.0] - 2026-09-09

### Added
- Added a DkimKeyProvider abstraction (FsDkimKeyProvider/NullDkimKeyProvider) so a deployment can opt into automatic per-domain DKIM key generation instead of the previous admin-fills-it-in-by-hand-only model
- Added GET /internal/mta/domain to BaseMailIngestRoute so an MTA's relay-domain acceptance check can stay in sync with this app's own Domain database dynamically, with no MTA restart needed
- Added test/dkim/FsDkimKeyProvider.test.ts, test/routes/{mongo,sql}/DomainRoute.dkim.test.ts, new /internal/mta/domain cases in the existing MailIngestRoute tests, and a real-DI regression test for the ScanPipeline config-default fix

### Changed
- Wire DkimKeyProvider into BaseDomainRoute.create() (auto-fills dkimSelector/dkimPublicKey unless the caller already supplied both) and dnsSetup() (lazily backfills a pre-existing domain missing them)
- Register NullDkimKeyProvider as the default test double, required because @Inject throws when nothing at all is registered under a token
- Document the new /internal/mta/domain endpoint in transport/MTAIngestAdapter.ts alongside the existing resolve/deliver contract
- Update Domain.dkimSelector/dkimPublicKey doc comments, which previously asserted this library never generates or stores DKIM key material

### Fixed
- Fixed ScanPipeline's allowedTags @Config field having no default, which made ObjectFactory.initialize() throw for any deployment that never explicitly sets mail:scan:sanitize:allowed_tags, silently disabling all spam/AV scanning

## [0.3.1] - 2026-09-09

### Added
- Added an IANA's Special-Use Domain Name now skips validation and is automatically set as verified

### Changed
- Cleaning up contributors
- Updated readme

## [0.3.0] - 2026-09-09

### Added
- Added BaseMailboxRoute.autoProvision()/listDomains() and enforce the mail:domains allowlist in create()
- Added mail:auto_provision:static_aliases as a bypass for consumers with no reachable auth-server, e.g. a dev-mode server that can't self-fetch its own listening address mid-request
- Added TaskList entity (mailboxUid, name) as a direct structural copy of ContactList, with full mongo+sql CRUD routes and permission tests
- Added Task.taskListUid/assignedTo, Contact.categories, and Folder.color fields
- Added Contact.favorite/Task.myDay as optional fields instead of required-with-default, since a required boolean with only a TS-level default breaks real SQL schema migration against existing rows
- Added MailFilterRule entity (mailbox-scoped inbox rules: conditions, ordered actions, stopProcessingRules), evaluated in ScanQueueJob against newly-delivered mail with move/copy/delete/mark-as-read/forward actions
- Added Message.scheduledSendTime and a deferred-send branch in BaseMessageRoute.send() that moves the message to Outbox instead of relaying, plus a new ScheduledSendJob that relays due messages
- Added MailSignature entity (roaming, OWA-style) with a resolveDefaultSignature() helper for composing clients to share
- Added automatic out-of-office replies via resolveActiveOof(), combining Mailbox.oofEnabled with a new CalendarEvent.autoReplyEnabled/autoReplyMessage window, isAutoReplyEligible() for RFC 3834 loop prevention, and a new OofReplySuppression entity with OofReplySuppressionCleanupJob to throttle repeat replies per sender
- Added src/util/IcsUtils.ts for hand-rolled RFC 5545/5546 ICS generation and parsing (buildEventIcs/parseIcsEvent), including RRULE/EXDATE for master events, RECURRENCE-ID for single-occurrence overrides, and TZID conversion via Node's built-in Intl
- Added MeetingSchedulingJob support for sending iTIP REQUEST invites on CalendarEvent create/update (tracked via inviteSequenceSent) and CANCEL notices on cancellation/deletion (tracked via cancelNoticeSentAt), with recurring-series-aware de-duplication
- Added inbound iTIP processing to ScanQueueJob, detecting a text/calendar part and processing REQUEST (create/update the recipient's calendar entry), REPLY (update the organizer's attendee status), and CANCEL (soft-delete one occurrence or the whole series)
- Added BaseCalendarEventRoute auto-bumping of sequence on scheduling-relevant updates and a POST /:id/respond endpoint so a REST client can accept/decline/tentative without parsing email, always sending a real iTIP REPLY to the organizer
- Added a mail-enabled DistributionList entity (admin-only CRUD) whose membership can include internal mailboxes, nested lists, and genuinely external addresses
- Added recursive inbound list expansion with a cycle guard and depth cap, fanning out to internal members via one Reply-To/List-Id/List-Unsubscribe-rewritten copy and relaying directly to external members via MailTransport
- Added unsubscribe handling: a member emailing the list with Subject: unsubscribe is removed and gets a confirmation
- Added an admin-only TransportRule entity evaluated once per SMTP transaction in BaseMailIngestRoute.deliver(), before per-recipient resolution/fan-out, separate from the mailbox-scoped MailFilterRule that runs later per-recipient in ScanQueueJob
- Added TransportRule conditions mirroring MailFilterRule's substring-match model (from/subject/body/recipient contains, hasAttachment, attachment name) plus an anyRecipientExternal check against mail:domains
- Added reject, quarantine, add_header, and add_recipient transport-rule actions, with quarantine stamping IngestQueueEntry.quarantineReason so ScanQueueJob forces that verdict once scanning completes
- Added MimeHeaderUtils.ts, extracting the raw-MIME header read/rewrite primitives shared by distribution lists and transport rules
- Added isResource/resourceType/autoAcceptBookings/allowConflicts/bookingWindowDays/maxDurationMinutes fields to Mailbox so it can represent a bookable resource, mirroring Exchange's room/equipment auto-processing
- Added automatic accept/decline of inbound iTIP REQUESTs to resource mailboxes in ScanQueueJob, via a new expandOccurrences() RRULE occurrence expander that checks duration/booking-window policy and full recurring-series conflict detection
- Added BaseMessageRoute.recall(), composing an X-RapidMX-Recall-Of control message to a sent message's original recipients
- Added recall handling to ScanQueueJob, deleting the recipient's still-unread copy (leaving a read copy alone) and reporting the outcome back to the sender as a plain email
- Added Message.conversationId, computed once at creation time from References/In-Reply-To/Message-ID via a new deriveConversationId() utility, populated on both ingest (ScanQueueJob) and send (MailSendUtils)
- Added BaseMessageRoute.conversations(), a mailbox-wide endpoint that groups messages by conversationId across every folder, mirroring BaseFolderRoute.find()'s mailbox-level ACL check
- Added a durable AuditLogEntry (Mongo/SQL) recorded for DistributionList/TransportRule create/update/delete, trusted-caller Mailbox creation, and Message delete/recall, mirrored through EventUtils.record()
- Added a read-only audit-log route that blocks writes for every caller including admins, since ACLUtils.hasPermission() bypasses class ACL for trusted users and a deny-all grant alone can't stop them
- Added a DB-backed, admin-managed Domain entity with full CRUD, replacing the static mail:domains config everywhere it was consulted with one consistent enabled-and-verified definition
- Added TXT-record-token domain ownership verification, checked periodically by DomainVerificationJob and on demand via a manual verify action, both through a pluggable DnsResolver interface
- Added a read-only GET /:id/dns-setup endpoint that computes and live-checks the MX/SPF/DKIM/DMARC records a domain needs beyond ownership proof
- Added DnsResolver.resolveMx() alongside the existing resolveTxt()
- Added mail:dns:mx_hostname config, driving the MX/SPF recommendations for every domain
- Added DKIM/DMARC recommendation support without ever generating or storing key material, since an admin supplies the selector and public key from their own MTA/OpenDKIM setup
- Added MessageClassification enum (focused/other) and an optional Message.inferenceClassification field, absent meaning treat as Focused for existing mail
- Added FocusedInboxOverride entity (mailboxUid + senderAddress -> classifyAs) with a compound index and a deny-all class ACL, managed through a BaseScopedChildRoute scoped to the owning mailbox
- Added FocusedInboxUtils.classifyMessage() as a pure function with precedence explicit override, then bulk/automated indicators, then internal sender, then known correspondent, then spam score, defaulting to Focused
- Added lazy classification in ScanQueueJob.deliverMessage() that short-circuits for junk-routed and non-Inbox mail before any of the three extra lookups run
- Added a ScanPipeline raw-header reader for listUnsubscribeHeader, since mailparser folds every List-* header into one structured list key
- Added POST /messages/:id/classify with { classifyAs, applyToSender } for the Always move to Other gesture
- Added BookingType/Booking entities (Mongo + SQL) with a deny-all class ACL, since anonymous access is granted only by the public route resolving a slug or manageToken, never through the ACL system
- Added FreeBusyUtils.computeBusyWindows(), lifting the conflict-detection core out of ScanQueueJob.decideResourceBooking() into a reusable pure function that also filters cancelled/free-status events
- Added BookingUtils.generateCandidateSlots()/subtractBusy() as pure slot-math functions, converting local availability windows to UTC via the now-exported IcsUtils.convertLocalToUtc() so a 09:00 window stays 09:00 local across a DST transition
- Added BaseBookingTypeRoute as the host's ordinary mailboxUid-scoped BaseScopedChildRoute CRUD, with slug normalization/collision checking and availability validation
- Added BaseBookingRoute as the anonymous half, built in the shape of BaseMailIngestRoute with its own repos and ignoreACL: true throughout, wrapping the CalendarEvent+Booking write pair in @Transactional() and rate-limiting its three mutating endpoints
- Added Gmail-style plus-addressing so user+tag@domain.com resolves to mailbox user@domain.com at delivery time
- Added AddressUtils.stripPlusTag(), stripping everything from the first + in the local part onward without touching the domain
- Added a third fallback tier to BaseMailIngestRoute.findMailboxByAddress(): exact primarySmtpAddress, then exact aliasAddresses, then both again against the plus-stripped base address, with exact matches always winning first
- Added mail:plus_addressing:enabled config, default on
- Added an admin-managed, publicly-readable Branding record (logo, product title/company name, stylesheet, web-client UI chrome) for a downstream server or web client to render
- Added Branding as a singleton entity (fixed uid: branding), created lazily on the first admin write, with a deny-all class ACL since the public read is a route-level decision, not an ACL grant
- Added BaseBrandingRoute as a bespoke class mixing BaseBookingRoute's unauthenticated public reads with BaseDomainRoute's @RequiresTrustedRole() admin writes and recordAuditLog() usage
- Added logoUrl/stylesheetUrl support for both a plain external URL and an upload through POST /branding/logo or /branding/stylesheet, storing the file via BlobStore and cleaning up the replaced blob when switching modes
- Added a genuine RFC 3798 Message Disposition Notification implementation on both the generating and parsing sides, so the indicator mechanism works regardless of who generated the receipt
- Added util/ReceiptUtils.ts, building and parsing real multipart/report report-type=disposition-notification messages via nodemailer's MimeNode builder, using Disposition displayed for read receipts and processed for delivery receipts
- Added Message.requestReceipt and Mailbox.alwaysRequestReceiptInternal/External so send() attaches Disposition-Notification-To when it applies to any recipient and seeds one receiptStatus roster entry per recipient
- Added Mailbox.autoSendReceiptsInternal/External, classified via the new DomainUtils.isInternalAddress(), auto-sending or holding a receipt pending approval via POST /:id/receipt/approve or /decline
- Added delivery-receipt generation to ScanQueueJob at delivery time and inbound-MDN detection correlated by (mailboxUid, messageId) and Final-Recipient, never filing the MDN as a visible message
- Added BaseMessageRoute's update() override to trigger the read receipt on flags.read's first false-to-true transition

### Changed
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Change Mailbox/DistributionList uid to derive from the entity's own address instead of a random id, closing a cross-entity address-collision gap
- Upgrade @rapidrest/service-core to ^1.5.0 for @RequiresTrustedRole(), replacing hand-rolled trusted-role checks with the framework's own decorator
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Changing in-process db query filtering to use db-native query filtering
- Upgraded @rapidrest/service-core to 1.6.0
- Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
- Note known limitations: the double-booking race is narrowed but not closed, manageToken has no expiry/GC job, and recurring busy blocks inherit expandOccurrences()'s DST-naivety
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Changed `IcsUtils.formatDateUtc()` to take a `Date` or `string`. This fixes an issue with documents retrieved from MongoDB that return as strings.
- Note this is scoped to mailbox delivery-routing only, not authentication/login and not DistributionList addresses, since the delivered message's To: header is parsed independently and untouched by this routing change
- Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Updated claude intsructions regarding commit messages
- Updated CI build workflow
- Upgraded all dependencies

### Fixed
- Fixed ScanQueueJob hardcoding Message.subject/bodyPreview to empty strings instead of using the values ScanPipeline already parsed
- Fixed ScheduledSendJob silently failing to clear scheduledSendTime on the SQL backend, since TypeORM's Repository.update() skips undefined properties and only an explicit null clears a column
- Fixed scanAndRelay() to guarantee every message has a Message-ID before relay, generating and injecting one when the composing client didn't set it, applied consistently for both immediate sends and ScheduledSendJob
- Fixed ScanPipeline to strip angle brackets from In-Reply-To/References/Message-ID consistently, since mailparser left them bracketed unlike this library's own send-side normalization, which would have silently broken conversation grouping and recall()'s cross-mailbox Message-ID matching
- Fixed a latent case-sensitivity bug in domain matching, surfaced by moving to real lowercase-normalized Domain rows instead of static config
- Fixed CI publish job
- Fixed @rapidrest/service-core's @RateLimit decorator never calling next() on its success path, upgrading to 1.7.1
- Fixed GET /branding to never 404, returning all-empty defaults before anything has been configured
- Fixed ScanQueueJob.processReceipt() trusting an inbound MDN's claimed Final-Recipient without checking it matched the message's actual envelope sender, letting anyone who could email a mailbox forge fake delivery/read receipts for arbitrary addresses
- Fixed declining a pending receipt not durably sticking, since marking a message unread then read again re-triggered the same hold-for-approval flow it was meant to close
- Fixed a distribution list whose address contained a plus sign being silently shadowed by an unrelated mailbox via the plus-addressing fallback, since mailbox resolution ran before the distribution-list check
- Fixed the same plus-addressing fallback letting a sender evade a transport rule scoped to a specific recipient by tagging the address
- Fixed a legally-folded Original-Message-ID header corrupting MDN-to-message correlation
- Fixed duplicate recipient addresses seeding duplicate, unmergeable receipt-status rows
- Fixed a narrow TOCTOU race on the branding singleton's create-if-missing during the very first concurrent write

### Removed
- Removed a dead, unreachable !aclRepo guard in MailboxRouteMongo/SQL's findAccessibleMailboxUids(), closing a lines-coverage gap that had persisted across sessions

## [0.2.0] - 2026-09-07

### Added
- Added EAS Sync multi-collection, RemoteWipe, and OOF fields to models

### Changed
- Eagerly provision Inbox/Drafts folders when a mailbox is created
- - BaseMailboxRoute.create() now creates the Inbox and Drafts folders immediately, since a brand-new mailbox with neither is unusable in a webmail client (MailShell/Compose both require them to exist)
- - MailboxRouteMongo/MailboxRouteSQL supply the concrete Folder class for the new provisioning step
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- DeviceSyncState gains folderCollectionClasses (remembers a synced
- collection's Class so it can be omitted on later Sync requests, per
- MS-ASCMD) and remoteWipeRequested/remoteWipeAccountOnly/
- remoteWipeAcknowledgedAt (MS-ASPROV RemoteWipe). Mailbox gains
- oofEnabled/oofMessage/oofStartTime/oofEndTime (MS-ASSettings Oof).
- oofMessage needed @Nullable despite being a required string: this
- framework's ObjectUtils.validate() treats an empty string as
- equivalent to null/undefined for any non-nullable field, and this
- field's natural default (no OOF message configured) is "". Also fixes
- a related test-helper gap in MailboxRoute.test.ts (SQL): an unset
- nullable Date column round-trips as null, not undefined, which a
- strict toEqual was treating as a real mismatch.
- These fields are consumed by the in-progress @rapidmx/activesync work
- (client-Class-omission on Sync, Provision RemoteWipe flow, Settings
- Oof) via a local portal: link, not a version bump.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Eagerly provision Calendar, Contacts, and Tasks folders when a mailbox is created
- - BaseMailboxRoute.create() now also creates the calendar/contacts/tasks well-known folders alongside the existing inbox/drafts, since the webmail client now has permanent nav destinations for each
- - Update MailboxRoute integration tests' expected folder list accordingly
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

[Unreleased]: https://github.com/RapidMX/restapi/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/RapidMX/restapi/compare/v0.4.0...v0.6.0
[0.4.0]: https://github.com/RapidMX/restapi/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/RapidMX/restapi/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/RapidMX/restapi/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/RapidMX/restapi/compare/v0.1.0...v0.2.0
