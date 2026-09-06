///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/**
 * Documents the HTTP contract an MTA (Postfix, Haraka, ...) integrates against to hand accepted internet mail
 * to this library. This is not a pluggable interface implemented in code — it is the fixed shape that
 * `BaseMailIngestRoute` (see `routes/mongo/MailIngestRouteMongo.ts` / `routes/sql/MailIngestRouteSQL.ts`)
 * exposes, documented here as the integration target for whichever MTA a deployment chooses.
 *
 * Both endpoints are internal-only: bound to loopback/an internal network in the server's HTTP configuration,
 * and additionally gated by a shared bearer secret (`mail:transport:ingest:secret`) checked against the
 * `Authorization` header — never exposed to the public internet.
 *
 * ### `GET /internal/mta/resolve?rcpt=<address>`
 * Called by the MTA's recipient-validation hook (e.g. Postfix `recipient_lookup` via a `tcp_table`/socketmap,
 * or an LMTP handshake) before accepting a message for `rcpt`, so a message for a nonexistent mailbox is
 * rejected at the SMTP conversation stage rather than accepted and later bounced (avoiding backscatter).
 * Responds `200` if a `Mailbox` exists for `rcpt` (as a primary or alias address), `404` otherwise.
 *
 * ### `POST /internal/mta/deliver`
 * Called by the MTA's content-filter/pipe once it has accepted a message. The request body is the raw,
 * unparsed RFC 5322 message; envelope-from/envelope-to are carried as `X-Envelope-From`/`X-Envelope-To`
 * headers. The handler does only the minimum synchronous work — persist the raw bytes to the `BlobStore` and
 * create an `IngestQueueEntry` — then returns `202` immediately, deferring parsing/scanning/delivery to
 * `ScanQueueJob`. This bounds SMTP-transaction latency and lets the MTA's own queue (not this library's) own
 * retry/backpressure semantics.
 */
export const MTA_INGEST_CONTRACT_DOC =
    "See MTAIngestAdapter.ts for the GET /internal/mta/resolve and POST /internal/mta/deliver contract.";
