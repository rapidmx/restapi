///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { ApiError, type ObjectFactory } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import { BlobStore } from "../blob/BlobStore.js";
import type { DnsResolver } from "../dns/DnsResolver.js";
import type { Mailbox, MessageReceiptEntry, PublicKey } from "../models/types.js";
import { MailRelayError, type MailRelayFailureDetails, relayFailureDetails } from "../transport/TransportResultUtils.js";
import { normalizeAddress } from "./AddressUtils.js";
import { deriveConversationId } from "./ConversationUtils.js";
import { classifyRecipientTier, createFederatedPeerCheck, getVerifiedDomainNames } from "./DomainUtils.js";
import { extractHeader, prependHeaders } from "./MimeHeaderUtils.js";
import { buildRapidMxKeyHeader } from "./RapidMxKeyHeaderUtils.js";
import { resolveDeliveryVerdict, ScanPipeline } from "../scan/ScanPipeline.js";

/** The outcome of `scanAndRelay()` a caller needs to finish persisting a sent message. */
export interface ScanAndRelayResult {
    /** The raw MIME actually scanned and relayed - identical to the input `raw` unless it had no
     * `Message-ID` header, in which case one was generated and injected (see `messageId` below). A caller
     * that persists `raw` (e.g. `BaseMessageRoute.send()`'s `bodyBlobKey`) must re-store THIS value, not its
     * own original buffer, so a later read - and any future `recall()` of this very message - sees the same
     * header it was actually relayed with. */
    raw: Buffer;

    /** The RFC 5322 `Message-ID` header value `raw` now carries, angle brackets stripped (matching
     * `ScanPipelineResult.messageIdHeader`'s own normalization, so a value stored here compares equal to
     * what every recipient's own ingest pipeline stores on their delivered `Message.messageId`). This is the
     * identifier `BaseMessageRoute.recall()` later targets - see its own doc comment. */
    messageId: string;

    /** Groups this message with the rest of its RFC 5322/2822 thread - see `util/ConversationUtils.ts`'s
     * `deriveConversationId()`, computed from the same scan that already parsed `raw`'s `References`/
     * `In-Reply-To` headers, so this needs no second parse. Derived from those headers alone: a caller that
     * can look the thread up in a mailbox refines it with `resolveConversationId()` (see
     * `BaseMessageRoute.send()`), which is what makes a chain deeper than one reply hold together. */
    conversationId: string;

    /** The `In-Reply-To` `raw` carries, angle brackets stripped - the `Message-ID` of the message this one
     * replies to, if any. Reported so a caller can persist it and resolve the thread against its own mailbox
     * without parsing the relayed bytes a second time. */
    inReplyTo?: string;

    /** The `References` `raw` carries, oldest first, angle brackets stripped; empty when it carries none. */
    references: string[];

    /** The blob key `scanResult.sanitizedHtml` (if any) was stored under - see the identical reasoning in
     * `ScanQueueJob.processEntry()`'s own doc comment on why this must never be folded into the raw body key. */
    sanitizedHtmlBlobKey?: string;

    /** `true` if the scan pipeline identified this message's body as S/MIME (CMS) encrypted - see
     * `util/SmimeUtils.ts`'s `isEncryptedBody()`. Threaded through so `BaseMessageRoute.send()` can persist
     * it onto the sent `Message`, the same signal `ScanQueueJob` stamps for inbound mail. */
    encrypted: boolean;

    /** Set when the transport relayed the message to some envelope recipients but refused others: what it said about
     * those it refused (`rejected`/`failures`), for the caller to tell the sender - see `util/DeliveryFailureNoticeUtils.ts`.
     * Absent when every recipient was accepted. */
    undelivered?: MailRelayFailureDetails;
}

/**
 * Runs `raw` through `ScanPipeline` and, if it passes, relays it via `mailTransport` - the scan-then-relay core
 * shared by every "send a composed message" entry point in this library (`BaseMessageRoute.send()`'s REST
 * endpoint and the EAS `SendMail`/`SmartForward`/`SmartReply` commands via `sendComposedMime()` below), so this
 * gate is defined exactly once rather than duplicated per protocol.
 *
 * Before scanning, guarantees `raw` carries a real `Message-ID` header - a compose client (webmail/EAS/MAPI)
 * usually sets one, but if it didn't, one is generated and injected here (reusing `MimeHeaderUtils`'s existing
 * header-prepend primitive) rather than leaving each recipient's own ingest pipeline to independently mint an
 * unrelated random one. Every cross-mailbox feature that needs to recognize "the same message" across copies
 * (`recall()` in particular) depends on this identifier actually matching everywhere.
 *
 * Throws `ApiError` (422) if the scan pipeline's verdict is anything other than "deliver", or a `MailRelayError`
 * (502) if the transport itself rejects the message outright - both cases callers should let propagate as the request's
 * own failure, not attempt to recover from. A `MailRelayError` says in plain words what was refused and carries the
 * transport's own diagnostic text (SMTP/enhanced status codes, responses, what `sendmail` printed) in `details`.
 * A transport that relays to some recipients and refuses others is not a failure: the refused ones are reported in the
 * result's `undelivered`.
 */
export async function scanAndRelay(
    raw: Buffer,
    envelopeFrom: string,
    envelopeTo: string[],
    scanPipeline: ScanPipeline,
    mailTransport: any,
    blobStore: BlobStore,
): Promise<ScanAndRelayResult> {
    let finalRaw = raw;
    const existingMessageId = extractHeader(raw, "Message-ID");
    let messageId: string;
    if (existingMessageId) {
        messageId = existingMessageId.replace(/^</, "").replace(/>$/, "");
    } else {
        const domain = envelopeFrom.split("@")[1] || "localhost";
        messageId = `${crypto.randomUUID()}@${domain}`;
        finalRaw = prependHeaders(raw, [{ name: "Message-ID", value: `<${messageId}>` }]);
    }

    // No preview: no caller of a send uses one (the draft already has its own), and deriving it converts the whole HTML body to text.
    const scanResult = await scanPipeline.run(finalRaw, { from: envelopeFrom, to: envelopeTo }, { skipPreview: true });
    const verdict = resolveDeliveryVerdict(scanResult);
    if (verdict !== "deliver") {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 422, "This message could not be sent because it failed spam/malware scanning.");
    }

    const transportResult = await mailTransport.send({ raw: finalRaw, envelopeFrom, envelopeTo });
    if (transportResult.accepted.length === 0) {
        throw new MailRelayError(relayFailureDetails(transportResult, envelopeTo, mailTransport.name));
    }

    let sanitizedHtmlBlobKey: string | undefined;
    if (scanResult.sanitizedHtml !== undefined) {
        sanitizedHtmlBlobKey = `sanitized/${crypto.randomUUID()}`;
        await blobStore.put(sanitizedHtmlBlobKey, Buffer.from(scanResult.sanitizedHtml, "utf-8"), { contentType: "text/html" });
    }

    const conversationId = deriveConversationId(scanResult.references, scanResult.inReplyTo, messageId);

    return {
        raw: finalRaw,
        messageId,
        conversationId,
        inReplyTo: scanResult.inReplyTo,
        references: scanResult.references,
        sanitizedHtmlBlobKey,
        encrypted: scanResult.encrypted,
        ...((transportResult.rejected ?? []).length > 0 ? { undelivered: relayFailureDetails(transportResult, envelopeTo, mailTransport.name) } : {}),
    };
}

/**
 * How many `Message-ID`s an outbound `References` header written by `applyThreadHeaders()` keeps, and how long
 * that header line may get. RFC 5322 caps a header line at 998 characters and a `References` chain grows by one
 * entry per reply forever, so a long-running thread's chain is trimmed rather than written out in full - which
 * RFC 5322 section 3.6.4 explicitly allows. The root is always kept (it is what `deriveConversationId()` reads),
 * and the entries dropped are the oldest ones after it, so the parent this message actually replies to stays.
 */
export const MAX_RELAYED_REFERENCES: number = 20;
export const MAX_RELAYED_REFERENCES_LENGTH: number = 900;

/** One `Message-ID` as it goes into an `In-Reply-To`/`References` header: no angle brackets, no whitespace and
 * nothing that could start a second header line. `undefined` when nothing usable is left. */
function headerMessageId(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const cleaned: string = value.replace(/[\r\n<>]/g, "").trim();
    return cleaned.length > 0 && !/\s/.test(cleaned) ? cleaned : undefined;
}

/**
 * The `In-Reply-To`/`References` headers a reply must carry, from what the draft recorded it is replying to -
 * or none at all when it is replying to nothing, or when the composed MIME already carries threading headers of
 * its own (a client that composed them itself, including a signed/encrypted body assembled client-side, is
 * never second-guessed).
 *
 * `References` is the thread's chain as the draft recorded it, with the parent's own `Message-ID` appended when
 * it isn't already the last entry - exactly the chain RFC 5322 section 3.6.4 prescribes for a reply - trimmed to
 * `MAX_RELAYED_REFERENCES` entries and `MAX_RELAYED_REFERENCES_LENGTH` characters from after the root.
 *
 * This is what actually makes threading work end to end: this server composes a reply's MIME from structured
 * compose input (recipients, subject, HTML), so unless these headers are written here, every recipient's ingest
 * pipeline sees a message that references nothing and files it as a brand-new conversation.
 */
export function threadHeaders(raw: Buffer, thread: { inReplyTo?: string; references?: string[] | null }): { name: string; value: string }[] {
    if (extractHeader(raw, "In-Reply-To") !== undefined || extractHeader(raw, "References") !== undefined) {
        return [];
    }
    const parent: string | undefined = headerMessageId(thread.inReplyTo);
    const chain: string[] = [];
    for (const reference of Array.isArray(thread.references) ? thread.references : []) {
        const id: string | undefined = headerMessageId(reference);
        if (id && !chain.includes(id)) {
            chain.push(id);
        }
    }
    if (parent && chain[chain.length - 1] !== parent) {
        const duplicate: number = chain.indexOf(parent);
        if (duplicate >= 0) {
            chain.splice(duplicate, 1);
        }
        chain.push(parent);
    }
    if (chain.length === 0) {
        return [];
    }
    const value = (): string => chain.map((id) => `<${id}>`).join(" ");
    while (chain.length > 1 && (chain.length > MAX_RELAYED_REFERENCES || value().length > MAX_RELAYED_REFERENCES_LENGTH)) {
        chain.splice(1, 1);
    }
    return [
        ...(parent ? [{ name: "In-Reply-To", value: `<${parent}>` }] : []),
        { name: "References", value: value() },
    ];
}

/** `raw` with `threadHeaders()` prepended, or `raw` itself when there are none to add. */
export function applyThreadHeaders(raw: Buffer, thread: { inReplyTo?: string; references?: string[] | null }): Buffer {
    const headers: { name: string; value: string }[] = threadHeaders(raw, thread);
    return headers.length > 0 ? prependHeaders(raw, headers) : raw;
}

/** What `prepareOutboundMime()` needs to know about the message being sent. */
export interface OutboundMessageInfo {
    from: { address: string };
    recipients: { address: string }[];
    /** An explicit per-draft receipt request, overriding all three of the mailbox's `alwaysRequestReceipt*` defaults. */
    requestReceipt?: boolean | null;
}

/**
 * The bytes a message is relayed as: `raw` with the headers the sending side adds at send time.
 *
 * - `Disposition-Notification-To` when a receipt is requested for any recipient. A receipt request is a single message-level
 * header (RFC 3798 has no "only for these recipients"), so it is attached when it applies to *any* recipient: each one is
 * classified same-organisation/federated/external (`classifyRecipientTier()`) and the per-draft `requestReceipt` overrides all
 * three of the mailbox's `alwaysRequestReceipt*` defaults at once when set.
 * - `RapidMX-Key`, announcing the mailbox's active (non-revoked, non-expired) encryption key.
 *
 * Shared by `BaseMessageRoute.send()` and `ScheduledSendJob`, so a message goes out the same whichever of them sends it - a
 * background send is relayed by the job. `attachesReceiptRequest` says whether the first header was added (the Sent Items
 * copy then tracks the receipts, see `seedReceiptStatus()`). Without a `domainClass` and a `dnsResolver` no recipient can be
 * classified and no receipt is requested.
 */
export async function prepareOutboundMime(args: {
    raw: Buffer;
    message: OutboundMessageInfo;
    mailbox: Mailbox | undefined;
    objectFactory: ObjectFactory;
    domainClass?: any;
    dnsResolver?: DnsResolver;
}): Promise<{ raw: Buffer; attachesReceiptRequest: boolean }> {
    const { message, mailbox, objectFactory } = args;
    let raw: Buffer = args.raw;
    const envelopeTo: string[] = message.recipients.map((recipient) => recipient.address);

    let attachesReceiptRequest = false;
    if (mailbox && args.domainClass && args.dnsResolver) {
        const effectiveInternal: boolean = message.requestReceipt ?? mailbox.alwaysRequestReceiptInternal;
        const effectiveFederated: boolean = message.requestReceipt ?? mailbox.alwaysRequestReceiptFederated;
        const effectiveExternal: boolean = message.requestReceipt ?? mailbox.alwaysRequestReceiptExternal;
        if (effectiveInternal || effectiveFederated || effectiveExternal) {
            // Fetched once and passed to every `classifyRecipientTier()` call (`verifiedDomainNames`) rather than each one
            // re-querying "this server's domains" from scratch. The per-recipient DNS federated-peer checks are independent
            // of each other, so they run concurrently - `resolveFederationPolicy()` already caches per domain.
            const verifiedDomainNames: string[] = await getVerifiedDomainNames(objectFactory, args.domainClass);
            const federatedPeerCheck = createFederatedPeerCheck(args.dnsResolver);
            const tiers = await Promise.all(
                envelopeTo.map((address) => classifyRecipientTier(objectFactory, args.domainClass, address, federatedPeerCheck, verifiedDomainNames)),
            );
            attachesReceiptRequest = tiers.some(
                (tier) =>
                    (tier === "same-org" && effectiveInternal) || (tier === "federated" && effectiveFederated) || (tier === "external" && effectiveExternal),
            );
        }
    }
    if (attachesReceiptRequest) {
        raw = prependHeaders(raw, [{ name: "Disposition-Notification-To", value: message.from.address }]);
    }

    // Announces the sending mailbox's current encryption key (the Autocrypt-style opportunistic-discovery half of the protocol).
    // `?? []`: defense in depth against a legacy row whose SQL `keys` column was backfilled to `null` rather than the column's
    // own default - the documented "SQL returns null, not undefined, for an unset column" hazard.
    const activeEncryptKey: PublicKey | undefined = (mailbox?.keys ?? []).find((k) => k.useType === "encrypt" && !k.revokedAt && k.notAfter > Date.now());
    if (activeEncryptKey) {
        raw = prependHeaders(raw, [
            {
                name: "RapidMX-Key",
                value: buildRapidMxKeyHeader(
                    message.from.address,
                    (mailbox!.encryptPreference ?? { preferEncrypt: "nopreference" }).preferEncrypt,
                    activeEncryptKey,
                ),
            },
        ]);
    }
    return { raw, attachesReceiptRequest };
}

/**
 * One placeholder row per *distinct* recipient (case variants across To/Cc collapse) for a Sent Items copy that requested
 * receipts, for `processReceipt()` to fill in as the real MDNs arrive. A `DistributionList`'s own address is kept as-is: its
 * expanded members can only be discovered later, as their own receipts arrive.
 */
export function seedReceiptStatus(envelopeTo: string[]): MessageReceiptEntry[] {
    const seen: Set<string> = new Set();
    const receiptStatus: MessageReceiptEntry[] = [];
    for (const address of envelopeTo) {
        const normalized: string = normalizeAddress(address);
        if (!seen.has(normalized)) {
            seen.add(normalized);
            receiptStatus.push({ recipientAddress: normalized });
        }
    }
    return receiptStatus;
}
