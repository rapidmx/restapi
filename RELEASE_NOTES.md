# Release Notes

## Unreleased

### HIPAA / GDPR / eDiscovery compliance suite

- **Legal Hold**: matters can now place an active litigation/compliance hold on a mailbox, blocking any
  permanent (purge) delete or bulk truncate of held messages until the hold is lifted or the matter closes.
  Ordinary soft-deletes remain unaffected.
- **Audit logging expansion**: an admin or delegate reading another user's mailbox profile or message
  content is now recorded as its own audited event, distinct from the mailbox owner's own (unaudited)
  activity.
- **Configurable data retention engine**: org-wide retention policies for messages and audit log entries,
  enforced by a background job that respects any active Legal Hold and never touches the tamper-evident
  escrow audit ledger.
- **GDPR data export**: any user (or an admin on their behalf) can request a full export of a mailbox's
  content as a real, interoperable Mbox file or a JSON portability bundle, processed asynchronously and
  downloaded once ready.
- **GDPR mailbox import**: import historical mail from an Mbox or PST file into a mailbox, scanned for
  malware the same way inbound mail is.
- **GDPR right to erasure**: self-service erasure requests, admin approval/denial, and an asynchronous
  cascade that permanently removes a mailbox and everything in it (respecting any active Legal Hold) once
  approved.
- **eDiscovery enhancements**: matter holders can export or full-text search across every custodian
  mailbox in a matter, scoped to the matter's own date range, with results/exports logged to the existing
  tamper-evident escrow audit ledger.

### Encryption & key management

- **Escrow Scoping**: admin-defined escrow scopes with dual-control (M-of-N) approval for releasing
  escrowed key material, backed by a hash-chained, tamper-evident audit ledger.
- **RFC 8823 email-based ACME automation**: signing certificates can now be enrolled and renewed entirely
  over email (`email-reply-00`), including an automated driver job that advances and installs certificates
  with no manual intervention.

### Other additions

- **S3-compatible blob storage backend**, supporting custom endpoints and path-style addressing for
  MinIO/R2/Spaces-style deployments.
- **Message labels**, with mail-filter-rule support for applying a label automatically on delivery, and a
  new `label:` search operator.
- Messages can now be explicitly archived.

## v0.6.0
