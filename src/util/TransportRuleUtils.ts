///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { convert } from "html-to-text";
import { AddressObject, ParsedMail, simpleParser } from "mailparser";
import { TransportRule, TransportRuleAction, TransportRuleActionType, TransportRuleConditions } from "../models/types.js";
import { addressDomainOf, stripPlusTag } from "./AddressUtils.js";
import { isEncryptedBody } from "./SmimeUtils.js";

/** The maximum length, in characters, of the plain-text body preview `buildTransportRuleContext()` derives -
 * mirrors `ScanPipeline`'s own `BODY_PREVIEW_MAX_LENGTH` constant (kept as a separate constant/parse rather
 * than shared - see the module doc comment below for why). */
const BODY_PREVIEW_MAX_LENGTH = 500;

/** The most of a message's plain-text body `bodyContains` looks at, in characters. Beyond it a rule cannot see - the limit that
 * keeps matching cheap - which a sender can only use by sending a body longer than a mail server accepts in practice. */
const BODY_TEXT_MAX_LENGTH = 1_000_000;

/** The fields of an inbound SMTP transaction `matchesTransportRuleConditions()`/`evaluateTransportRules()` need to
 * evaluate a `TransportRule` against - built once per transaction by `buildTransportRuleContext()`, from a
 * *lightweight* parse of the raw message, deliberately separate from `ScanPipeline`'s own later, heavier
 * parse (which also runs spam/AV scanning): the two happen in different processing stages (synchronously at
 * ingest, before per-recipient fan-out, vs. asynchronously per resolved mailbox in `ScanQueueJob`), so
 * re-parsing here is an accepted, deliberate tradeoff rather than an oversight. */
export interface TransportRuleMatchContext {
    fromAddress: string;
    subject: string;
    bodyPreview: string;
    /** The plain-text body `bodyContains` matches against - up to `BODY_TEXT_MAX_LENGTH` characters, so a rule cannot be evaded by
     * padding the start of a message. Falls back to `bodyPreview` when absent. */
    bodyText?: string;
    /** The addresses of the From header, which a rule on the sender matches as well as the envelope sender `fromAddress`. */
    headerFromAddresses?: string[];
    /** The addresses of the To and Cc headers, which `recipientContains` matches as well as the envelope recipients. */
    headerRecipientAddresses?: string[];
    /** The full envelope recipient list for this SMTP transaction (before any per-recipient resolution/
     * distribution-list expansion). */
    recipientAddresses: string[];
    /** `true` if any address in `recipientAddresses` has a domain not in this server's configured
     * `mail:domains` - precomputed by the caller (`buildTransportRuleContext()`) rather than re-derived here,
     * keeping `matchesTransportRuleConditions()` itself a pure function of its two arguments. */
    anyRecipientExternal: boolean;
    hasAttachment: boolean;
    attachmentFilenames: string[];
}

/** The outcome of folding every matching rule's actions together, for `BaseMailIngestRoute.deliver()` to
 * apply. */
export interface TransportRuleEvaluationResult {
    /** `true` if any matching rule's actions included `REJECT` - the whole message is dropped and a
     * rejection notice is sent to the sender; no other action's effect (`addHeaders`/`addRecipients`) is
     * applied when this is `true`. */
    reject: boolean;

    /** `true` if any matching rule's actions included `QUARANTINE` - every resolved recipient's copy is
     * routed to the existing quarantine mechanism instead of normal delivery/relay. */
    quarantine: boolean;

    /** One entry per matching `ADD_HEADER` action. */
    addHeaders: { name: string; value: string }[];

    /** One entry per matching `ADD_RECIPIENT` action's `recipientAddress`. */
    addRecipients: string[];
}

function containsAnyIgnoreCase(haystack: string, needles?: string[]): boolean {
    if (!needles || needles.length === 0) {
        return false;
    }
    const lower = haystack.toLowerCase();
    return needles.some((needle) => lower.includes(needle.toLowerCase()));
}

function containsAnyInList(haystackList: string[], needles?: string[]): boolean {
    if (!needles || needles.length === 0) {
        return false;
    }
    return haystackList.some((haystack) => containsAnyIgnoreCase(haystack, needles));
}

/**
 * Evaluates a single `TransportRule`'s `TransportRuleConditions` against `context`. Every populated
 * condition field must match (AND); a field holding an array of strings is itself OR-matched against its
 * entries - same evaluation shape as `MailFilterUtils.matchesConditions()`.
 */
export function matchesTransportRuleConditions(conditions: TransportRuleConditions, context: TransportRuleMatchContext): boolean {
    if (conditions.fromContains && !containsAnyInList([context.fromAddress, ...(context.headerFromAddresses ?? [])], conditions.fromContains)) {
        return false;
    }
    if (conditions.subjectContains && !containsAnyIgnoreCase(context.subject, conditions.subjectContains)) {
        return false;
    }
    if (conditions.bodyContains && !containsAnyIgnoreCase(context.bodyText ?? context.bodyPreview, conditions.bodyContains)) {
        return false;
    }
    if (
        conditions.recipientContains &&
        !containsAnyInList([...context.recipientAddresses, ...(context.headerRecipientAddresses ?? [])], conditions.recipientContains)
    ) {
        return false;
    }
    if (conditions.anyRecipientExternal !== undefined && conditions.anyRecipientExternal !== context.anyRecipientExternal) {
        return false;
    }
    if (conditions.hasAttachment !== undefined && conditions.hasAttachment !== context.hasAttachment) {
        return false;
    }
    if (
        conditions.attachmentNameContains &&
        !containsAnyInList(context.attachmentFilenames, conditions.attachmentNameContains)
    ) {
        return false;
    }
    return true;
}

function applyAction(result: TransportRuleEvaluationResult, action: TransportRuleAction): void {
    switch (action.type) {
        case TransportRuleActionType.REJECT:
            result.reject = true;
            break;
        case TransportRuleActionType.QUARANTINE:
            result.quarantine = true;
            break;
        case TransportRuleActionType.ADD_HEADER:
            if (action.headerName && action.headerValue !== undefined) {
                result.addHeaders.push({ name: action.headerName, value: action.headerValue });
            }
            break;
        case TransportRuleActionType.ADD_RECIPIENT:
            if (action.recipientAddress) {
                result.addRecipients.push(action.recipientAddress);
            }
            break;
    }
}

/**
 * Evaluates `rules` (only those with `enabled: true`, in ascending `sequence` order) against `context`,
 * folding every matching rule's actions into a single combined result. Stops evaluating further rules once
 * a matching rule has `stopProcessingRules: true` (same convention as `MailFilterUtils.evaluateMailFilterRules()`).
 */
export function evaluateTransportRules(rules: TransportRule[], context: TransportRuleMatchContext): TransportRuleEvaluationResult {
    const result: TransportRuleEvaluationResult = { reject: false, quarantine: false, addHeaders: [], addRecipients: [] };

    const sorted = rules.filter((rule) => rule.enabled).sort((a, b) => a.sequence - b.sequence);
    for (const rule of sorted) {
        if (!matchesTransportRuleConditions(rule.conditions, context)) {
            continue;
        }
        for (const action of rule.actions) {
            applyAction(result, action);
        }
        if (rule.stopProcessingRules) {
            break;
        }
    }

    return result;
}

/**
 * Builds a `TransportRuleMatchContext` from a raw RFC 5322 message and its envelope - a lightweight
 * `mailparser` parse (subject/body-preview/attachment filenames only, no spam/AV scanning), run once per
 * SMTP transaction at ingest time, before per-recipient resolution/fan-out. `domains` is this server's
 * configured `mail:domains` list, used to compute `anyRecipientExternal`.
 *
 * `plusAddressingEnabled` (mirrors `BaseMailIngestRoute`'s own config toggle - see `findMailboxByAddress()`)
 * additionally includes each recipient's plus-stripped base address in `recipientAddresses`: without it, a
 * `recipientContains` rule scoped to `sales@company.com` would never match a `RCPT TO: sales+urgent@company.com`
 * transaction even though it resolves to and is delivered at exactly the same mailbox - silently letting a
 * sender evade a mail-flow rule (e.g. REJECT/QUARANTINE targeting a specific recipient) just by adding a tag.
 * Only added when the feature is actually enabled, so this stays consistent with what `findMailboxByAddress()`
 * itself would resolve.
 */
export async function buildTransportRuleContext(
    raw: Buffer,
    envelopeFrom: string,
    envelopeTo: string[],
    domains: string[],
    plusAddressingEnabled: boolean = false,
): Promise<TransportRuleMatchContext> {
    const parsed: ParsedMail = await simpleParser(raw);

    // An S/MIME-encrypted body is ciphertext to this server - `bodyContains` can only ever see an empty
    // preview for it (mailparser never populates `parsed.text`/`parsed.html` from a non-text top-level part),
    // so it naturally never matches without any special-casing here. `hasAttachment`/`attachmentNameContains`
    // need one, though: mailparser folds the *entire* encrypted body (`application/pkcs7-mime`, or the
    // `application/pgp-encrypted`+`application/octet-stream` pair for `multipart/encrypted`) into
    // `parsed.attachments` as a synthetic "attachment" node, since neither content type is `text/plain`/
    // `text/html`. A real S/MIME `EnvelopedData` wraps the *entire* message body, so there is never a
    // genuinely separate, still-visible attachment alongside it - anything mailparser reports here for an
    // encrypted message is that synthetic node, not a real one, and must be ignored rather than surfaced as a
    // false-positive attachment match.
    const encrypted: boolean = isEncryptedBody(parsed);

    const bodyText: string = encrypted
        ? ""
        : ((typeof parsed.text === "string"
              ? parsed.text
              : typeof parsed.html === "string"
                ? convert(parsed.html, { wordwrap: false })
                : ""
          )?.trim().slice(0, BODY_TEXT_MAX_LENGTH) ?? "");
    const bodyPreview: string = bodyText.slice(0, BODY_PREVIEW_MAX_LENGTH);
    const headerAddresses = (field: AddressObject | AddressObject[] | undefined): string[] =>
        (Array.isArray(field) ? field : field ? [field] : []).flatMap((group) => group.value.map((entry) => entry.address).filter((address): address is string => !!address));

    const hasAttachment: boolean = !encrypted && (parsed.attachments ?? []).length > 0;
    const attachmentFilenames: string[] = encrypted
        ? []
        : (parsed.attachments ?? []).map((attachment) => attachment.filename).filter((filename): filename is string => !!filename);

    const anyRecipientExternal: boolean =
        domains.length > 0 &&
        envelopeTo.some((address) => {
            const domain = addressDomainOf(address);
            return !domain || !domains.includes(domain);
        });

    const recipientAddresses: string[] = plusAddressingEnabled
        ? Array.from(new Set(envelopeTo.flatMap((address) => [address, stripPlusTag(address)])))
        : envelopeTo;

    return {
        fromAddress: envelopeFrom,
        subject: parsed.subject ?? "",
        bodyPreview,
        bodyText,
        headerFromAddresses: headerAddresses(parsed.from),
        headerRecipientAddresses: [...headerAddresses(parsed.to), ...headerAddresses(parsed.cc)],
        recipientAddresses,
        anyRecipientExternal,
        hasAttachment,
        attachmentFilenames,
    };
}
