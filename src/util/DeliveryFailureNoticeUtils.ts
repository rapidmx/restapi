///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import MimeNode from "nodemailer/lib/mime-node/index.js";
import type { NotificationUtils, RepoUtils } from "@rapidrest/service-core";
import type { BlobStore } from "../blob/BlobStore.js";
import type { TransportError, TransportFailure } from "../transport/MailTransport.js";
import { cleanDiagnosticText } from "../transport/TransportResultUtils.js";
import { FolderType, MessageImportance, RecipientType } from "../models/types.js";
import { asEntity } from "./EntityUtils.js";
import { extractHeader } from "./MimeHeaderUtils.js";
import { findOrCreateWellKnownFolder } from "./FolderUtils.js";
import { boundIndexedValue, deriveConversationId } from "./ConversationUtils.js";
import { nameBasedUuid } from "./UuidUtils.js";

/** How many failed recipients a notice lists in full; the rest are counted. */
export const MAX_NOTICE_RECIPIENTS: number = 50;
/** The most of the original message's header block a notice carries. */
export const MAX_NOTICE_HEADER_BYTES: number = 16 * 1024;
/** The display name of the sender of a notice, as Postfix and Exchange present theirs. */
export const NOTICE_SENDER_NAME: string = "Mail Delivery System";

/**
 * What a `DeliveryFailureNotice` reports - one failed send. Nothing here is the message itself: the notice carries the
 * original's subject, date, `Message-ID` and header block (`originalHeaderBlock()`), never its body.
 */
export interface DeliveryFailureNoticeInput {
    /** The mailbox the notice is filed in (the sender's), and its primary address (who the notice is addressed to). */
    mailboxUid: string;
    mailboxAddress: string;
    /**
     * Identifies the failed send: a notice with a key already filed - even one the user has since deleted - is not filed
     * again, so a retried or replayed failure never produces two notices. Built with `deliveryFailureKey()`.
     */
    key: string;
    original: {
        subject?: string;
        /** The `Message-ID`, angle brackets stripped. */
        messageId?: string;
        /** When the message was sent, or was to be sent. */
        date?: Date;
        /** The conversation the original is in, so the notice joins it. */
        conversationId?: string;
        /** The original's header block (`originalHeaderBlock()`), attached as `text/rfc822-headers`. */
        headers?: string;
    };
    /** One entry per recipient that was not delivered to; at least one. */
    failures: TransportFailure[];
    /** The transport-level error, when the failure had one. */
    error?: TransportError;
    /** The `name` of the transport that failed. */
    transport?: string;
    /** The reason in words when it is not a mail system's own - e.g. this server refusing to send the message at all. */
    reason?: string;
    /** How many times relaying was attempted before giving up, when it was retried. */
    attempts?: number;
    /** Defaults to now. */
    now?: Date;
}

/** A composed notice - see `buildDeliveryFailureNotice()`. */
export interface DeliveryFailureNotice {
    /** The complete RFC 3464 report: `multipart/report; report-type=delivery-status`. */
    raw: Buffer;
    subject: string;
    /** The `Message-ID`, angle brackets stripped. */
    messageId: string;
    /** The system address it is from. */
    from: string;
    /** The short text a message list shows. */
    preview: string;
}

/** The dedupe key of one failed send: `kind` names the failure path, `parts` identify the send within it. */
export function deliveryFailureKey(kind: string, ...parts: string[]): string {
    return [kind, ...parts].join(":");
}

/** The uid a notice with `key` is filed under in `mailboxUid` - the same key always gives the same uid. */
export function deliveryFailureUid(mailboxUid: string, key: string): string {
    return nameBasedUuid(`delivery-failure:${mailboxUid}:${key}`);
}

/**
 * The header block of `raw` for a notice to carry: everything before the first blank line, without `Bcc` (a notice
 * may be forwarded, and the original's blind recipients are not for it to reveal), non-ASCII bytes replaced (a header
 * block is ASCII; RFC 2047 words are), and cut to `MAX_NOTICE_HEADER_BYTES`.
 */
export function originalHeaderBlock(raw: Buffer): string {
    const text: string = raw.toString("binary");
    const blank: RegExpMatchArray | null = text.match(/\r?\n\r?\n/);
    const block: string = blank?.index === undefined ? text : text.slice(0, blank.index);
    const lines: string[] = [];
    let skipping: boolean = false;
    for (const line of block.split(/\r?\n/)) {
        if (/^[ \t]/.test(line)) {
            if (!skipping) {
                lines.push(line);
            }
            continue;
        }
        skipping = /^bcc:/i.test(line);
        if (!skipping) {
            lines.push(line);
        }
    }
    return asciiOnly(lines.join("\r\n")).slice(0, MAX_NOTICE_HEADER_BYTES);
}

/**
 * What a notice says about the original message: the subject, date, `Message-ID` and conversation of `message`, and the
 * header block of its stored source when that can be read (`raw`, or else the blob at `message.bodyBlobKey`). An
 * unreadable source only means the notice carries no headers - it is still worth filing. `messageId` overrides the stored
 * one, which a draft that has never been relayed does not have.
 */
export async function describeOriginal(
    blobStore: BlobStore,
    message: { subject?: string; messageId?: string; sentDate?: Date; conversationId?: string; bodyBlobKey?: string },
    options: { messageId?: string; raw?: Buffer } = {},
): Promise<DeliveryFailureNoticeInput["original"]> {
    let raw: Buffer | undefined = options.raw;
    if (!raw && message.bodyBlobKey) {
        try {
            raw = await blobStore.get(message.bodyBlobKey);
        } catch {
            raw = undefined;
        }
    }
    const messageId: string | undefined = (options.messageId ?? message.messageId ?? (raw ? extractHeader(raw, "Message-ID") : undefined))
        ?.replace(/^</, "")
        .replace(/>$/, "");
    return {
        subject: message.subject,
        messageId: messageId || undefined,
        date: message.sentDate ? new Date(message.sentDate) : undefined,
        conversationId: message.conversationId || undefined,
        headers: raw ? originalHeaderBlock(raw) : undefined,
    };
}

/** `value` with every character outside printable ASCII (line breaks and tabs kept) replaced by `?`. */
function asciiOnly(value: string): string {
    return value.replace(/[^\t\r\n\x20-\x7e]/g, "?");
}

/** `value` on one line: line breaks and runs of white space become a single space. */
function oneLine(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

/** The RFC 3463 status of `failure`: its enhanced code, else the class its SMTP code or `temporary` flag implies. */
function statusOf(failure: TransportFailure): string {
    if (failure.enhancedCode) {
        return failure.enhancedCode;
    }
    if (failure.code !== undefined) {
        return `${String(failure.code)[0]}.0.0`;
    }
    return failure.temporary === true ? "4.0.0" : "5.0.0";
}

/** The `Diagnostic-Code` field of `failure`: an `smtp` one when the mail system's reply is an SMTP one, else ours. */
function diagnosticOf(failure: TransportFailure): string | undefined {
    const text: string | undefined = failure.response ?? failure.stderr;
    if (!text) {
        return undefined;
    }
    const line: string = asciiOnly(oneLine(text)).slice(0, 900);
    return failure.code !== undefined || failure.enhancedCode ? `smtp; ${line}` : `X-RapidMX; ${line}`;
}

/** The RFC 3464 `message/delivery-status` body: one per-message group, then one group per failed recipient. */
function deliveryStatusOf(input: DeliveryFailureNoticeInput, domain: string, now: Date): string {
    const groups: string[] = [
        [`Reporting-MTA: dns; ${asciiOnly(domain)}`, ...(input.original.date ? [`Arrival-Date: ${input.original.date.toUTCString()}`] : [])].join("\r\n"),
    ];
    for (const failure of input.failures.slice(0, MAX_NOTICE_RECIPIENTS)) {
        const diagnostic: string | undefined = diagnosticOf(failure);
        groups.push(
            [
                `Final-Recipient: rfc822; ${asciiOnly(oneLine(failure.address))}`,
                "Action: failed",
                `Status: ${statusOf(failure)}`,
                ...(diagnostic ? [`Diagnostic-Code: ${diagnostic}`] : []),
                `Last-Attempt-Date: ${now.toUTCString()}`,
            ].join("\r\n"),
        );
    }
    return groups.join("\r\n\r\n") + "\r\n";
}

/** The plain-language part of a notice. */
function summaryOf(input: DeliveryFailureNoticeInput, domain: string, now: Date): string {
    const lines: string[] = [`This is the mail system at ${domain}.`, ""];
    const temporary: boolean = input.failures.length > 0 && input.failures.every((failure) => failure.temporary === true);
    lines.push(
        "Your message could not be delivered to " +
            (input.failures.length === 1 ? "this recipient" : "these recipients") +
            (temporary
                ? input.attempts
                    ? ` - the failure looked temporary, but delivery was still failing after ${input.attempts} attempts, so the mail system has given up.`
                    : " - the failure looked temporary, but the mail system has given up."
                : ". The mail system will not try again."),
        "",
    );
    if (input.reason) {
        lines.push(`Reason: ${input.reason}`, "");
    }
    lines.push(
        `  Subject:    ${oneLine(input.original.subject ?? "") || "(no subject)"}`,
        ...(input.original.date ? [`  Sent:       ${input.original.date.toUTCString()}`] : []),
        ...(input.original.messageId ? [`  Message-ID: <${oneLine(input.original.messageId)}>`] : []),
        `  Reported:   ${now.toUTCString()}`,
        "",
        "Recipients that could not be reached:",
        "",
    );
    for (const failure of input.failures.slice(0, MAX_NOTICE_RECIPIENTS)) {
        lines.push(`  ${oneLine(failure.address)}`);
        lines.push(`    Status:           ${statusOf(failure)} (${failure.temporary === true ? "temporary" : "permanent"} failure)`);
        if (failure.code !== undefined) {
            lines.push(`    SMTP reply code:  ${failure.code}`);
        }
        if (failure.response) {
            lines.push(`    Server response:  ${indent(failure.response, 22)}`);
        }
        if (failure.command) {
            lines.push(`    Command:          ${oneLine(failure.command)}`);
        }
        if (failure.stderr && failure.stderr !== failure.response) {
            lines.push(`    Delivery agent output:`, indent(failure.stderr, 6, true));
        }
    }
    if (input.failures.length > MAX_NOTICE_RECIPIENTS) {
        lines.push(`  ...and ${input.failures.length - MAX_NOTICE_RECIPIENTS} more`);
    }
    const details: string[] = [];
    if (input.transport) {
        details.push(`  Transport:   ${oneLine(input.transport)}`);
    }
    if (input.error) {
        details.push(`  Error:       ${indent(input.error.message, 15)}${input.error.code ? ` (${input.error.code})` : ""}`);
        if (input.error.exitCode !== undefined) {
            details.push(`  Exit status: ${input.error.exitCode}`);
        }
        if (input.error.responseCode !== undefined) {
            details.push(`  Reply code:  ${input.error.responseCode}`);
        }
        if (input.error.requestId) {
            details.push(`  Request id:  ${oneLine(input.error.requestId)}`);
        }
    }
    if (details.length > 0) {
        lines.push("", "Technical details:", "", ...details);
    }
    lines.push(
        "",
        "The headers of your original message are attached; its body is not included. If this keeps happening, give this",
        "message to your administrator.",
        "",
    );
    return lines.join("\r\n");
}

/** `text` with every line after the first indented by `spaces` (all of them too, with `all`). */
function indent(text: string, spaces: number, all: boolean = false): string {
    const pad: string = " ".repeat(spaces);
    return text
        .split("\n")
        .map((line, index) => (index === 0 && !all ? line : pad + line))
        .join("\r\n");
}

/**
 * Composes the notice for a failed send: an RFC 3464 delivery status notification - `multipart/report;
 * report-type=delivery-status` holding a plain-language summary, a `message/delivery-status` part with the SMTP status,
 * remote response and (when known) temporary/permanent nature of each failed recipient, and the original's headers as
 * `text/rfc822-headers`.
 *
 * It comes from `Mail Delivery System <postmaster@DOMAIN>` (the mailbox's own domain; the same identity
 * `BaseMailIngestRoute` gives its rejection notices) and is marked so it can never start a loop: `Auto-Submitted:
 * auto-replied` (what Postfix puts on its own bounces, so an auto-responder stays quiet), `X-Auto-Response-Suppress:
 * All`, and a null `Return-Path`. It carries `In-Reply-To`/`References` of the original, when that has a `Message-ID`.
 */
export async function buildDeliveryFailureNotice(input: DeliveryFailureNoticeInput): Promise<DeliveryFailureNotice> {
    const now: Date = input.now ?? new Date();
    const domain: string = input.mailboxAddress.split("@")[1] || "localhost";
    const from: string = `postmaster@${domain}`;
    const subject: string = `Undeliverable: ${oneLine(input.original.subject ?? "") || "your message"}`.slice(0, 250);
    const messageId: string = `${crypto.randomUUID()}@${domain}`;

    const root: MimeNode = new MimeNode("multipart/report; report-type=delivery-status", { disableFileAccess: true, disableUrlAccess: true });
    root.setHeader("Return-Path", "<>");
    root.setHeader("From", `${NOTICE_SENDER_NAME} <${from}>`);
    root.setHeader("To", input.mailboxAddress);
    root.setHeader("Subject", subject);
    root.setHeader("Date", now.toUTCString());
    root.setHeader("Message-ID", `<${messageId}>`);
    root.setHeader("Auto-Submitted", "auto-replied");
    root.setHeader("X-Auto-Response-Suppress", "All");
    if (input.original.messageId) {
        root.setHeader("In-Reply-To", `<${oneLine(input.original.messageId)}>`);
        root.setHeader("References", `<${oneLine(input.original.messageId)}>`);
    }
    root.createChild("text/plain; charset=utf-8").setContent(summaryOf(input, domain, now));
    root.createChild("message/delivery-status").setContent(deliveryStatusOf(input, domain, now));
    root.createChild("text/rfc822-headers").setContent(input.original.headers ?? "");

    const first: TransportFailure = input.failures[0];
    const why: string = cleanDiagnosticText(first?.response ?? input.reason ?? input.error?.message, 160)?.split("\n")[0] ?? "delivery failed";
    return {
        raw: await root.build(),
        subject,
        messageId,
        from,
        preview: `Delivery to ${first?.address ?? "the recipient"} failed: ${why}`.slice(0, 250),
    };
}

/** What `fileDeliveryFailureNotice()` files into: the repos and classes of one mailbox datastore. */
export interface DeliveryNoticeSink {
    messageRepo: RepoUtils<any>;
    messageClass: any;
    folderRepo: RepoUtils<any>;
    folderClass: any;
    blobStore: BlobStore;
    /** Tells connected clients (`sendMessage()`) about the new message; skipped when there is none. */
    notificationUtils?: NotificationUtils;
    logger?: any;
}

/** How often bumping the Inbox's counters is retried when another writer changes the folder first. */
const FOLDER_COUNTER_ATTEMPTS = 5;

/** Adds a message to `folder`'s counters, re-reading and retrying when a concurrent write bumped its version first. */
async function bumpInboxCounters(repo: RepoUtils<any>, folder: any): Promise<void> {
    let current: any = folder;
    for (let attempt = 1; ; attempt++) {
        try {
            await repo.update(
                {
                    uid: current.uid,
                    version: current.version,
                    unreadCount: current.unreadCount + 1,
                    totalCount: current.totalCount + 1,
                    syncKeyVersion: current.syncKeyVersion + 1,
                } as any,
                asEntity(repo, current),
                { ignoreACL: true },
            );
            return;
        } catch (err) {
            const refetched: any = attempt < FOLDER_COUNTER_ATTEMPTS ? await repo.findOne(folder.uid, { ignoreACL: true }) : undefined;
            if (!refetched || refetched.version === current.version) {
                throw err;
            }
            current = refetched;
        }
    }
}

/**
 * Files a delivery failure notice (`buildDeliveryFailureNotice()`) into the sender's Inbox, unread, and tells connected
 * clients about it exactly as delivery of any inbound message does (`NotificationUtils.sendMessage()` on the Inbox's
 * uid), so it appears at once.
 *
 * Idempotent: the row's uid derives from the mailbox and `input.key` (`deliveryFailureUid()`), so a failure reported
 * twice - a retried job, a replayed request, a concurrent replica - files one notice, and one the user has deleted is not
 * filed back. Returns the new message, or `undefined` when there already was one.
 *
 * Filed directly rather than queued for `ScanQueueJob`: the server wrote it, so there is nothing to scan, and it must not
 * be held up behind, or quarantined by, a scan.
 */
export async function fileDeliveryFailureNotice(sink: DeliveryNoticeSink, input: DeliveryFailureNoticeInput): Promise<any | undefined> {
    const uid: string = deliveryFailureUid(input.mailboxUid, input.key);
    if (await sink.messageRepo.findOne(uid, { ignoreACL: true, includeDeleted: true })) {
        return undefined;
    }
    const notice: DeliveryFailureNotice = await buildDeliveryFailureNotice(input);
    const bodyBlobKey: string = `notices/${uid}`;
    await sink.blobStore.put(bodyBlobKey, notice.raw, { contentType: "message/rfc822" });

    const inbox: any = await findOrCreateWellKnownFolder(sink.folderRepo, sink.folderClass, input.mailboxUid, FolderType.INBOX);
    const now: Date = input.now ?? new Date();
    let message: any;
    try {
        message = await sink.messageRepo.create(
            new sink.messageClass({
                uid,
                folderUid: inbox.uid,
                mailboxUid: input.mailboxUid,
                messageId: boundIndexedValue(notice.messageId),
                subject: notice.subject,
                from: { address: notice.from, displayName: NOTICE_SENDER_NAME, type: RecipientType.TO },
                recipients: [{ address: input.mailboxAddress, type: RecipientType.TO }],
                sentDate: now,
                receivedDate: now,
                bodyBlobKey,
                bodyPreview: notice.preview,
                flags: { read: false, flagged: false, answered: false, forwarded: false },
                importance: MessageImportance.HIGH,
                inReplyTo: input.original.messageId,
                references: input.original.messageId ? [input.original.messageId] : [],
                conversationId: input.original.conversationId ?? deriveConversationId(input.original.messageId ? [input.original.messageId] : [], undefined, notice.messageId),
                hasAttachments: false,
                labelUids: [],
                encrypted: false,
                deliveryReceiptPending: false,
            }),
            { ignoreACL: true },
        );
    } catch (err) {
        // A concurrent filer of the same failure won the uid.
        if (await sink.messageRepo.findOne(uid, { ignoreACL: true, includeDeleted: true })) {
            return undefined;
        }
        throw err;
    }
    await bumpInboxCounters(sink.folderRepo, inbox);
    sink.notificationUtils?.sendMessage(inbox.uid, sink.messageClass.name, "create", message);
    return message;
}

/**
 * `fileDeliveryFailureNotice()` for a caller that has no way to handle its failing: whatever goes wrong - reading what
 * the notice needs (`build`) or filing it - is logged (as `label`) and swallowed, because failing to tell the sender must
 * never make the failure it reports worse. `build` may return `undefined` when there is nobody to tell (the mailbox is
 * gone). Returns the filed message, or `undefined` when nothing was filed.
 */
export async function tryFileDeliveryFailureNotice(
    sink: DeliveryNoticeSink,
    label: string,
    build: () => Promise<DeliveryFailureNoticeInput | undefined>,
): Promise<any | undefined> {
    try {
        const input: DeliveryFailureNoticeInput | undefined = await build();
        return input ? await fileDeliveryFailureNotice(sink, input) : undefined;
    } catch (err: any) {
        sink.logger?.warn(`Failed to file the delivery failure notice for ${label}: ${err?.message ?? err}`);
        return undefined;
    }
}
