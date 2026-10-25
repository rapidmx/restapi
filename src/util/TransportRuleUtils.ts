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

/** `lower` (already lowercased) contains any of `needles`, ignoring case. */
function containsAnyIgnoreCase(lower: string, needles?: string[]): boolean {
    if (!needles || needles.length === 0) {
        return false;
    }
    return needles.some((needle) => lower.includes(needle.toLowerCase()));
}

function containsAnyInList(lowerList: string[], needles?: string[]): boolean {
    if (!needles || needles.length === 0) {
        return false;
    }
    return lowerList.some((lower) => containsAnyIgnoreCase(lower, needles));
}

/** The lowercased text of a context the conditions match, each field made on first use and then kept. */
interface LoweredContext {
    readonly from: string[];
    readonly subject: string;
    readonly body: string;
    readonly recipients: string[];
    readonly attachmentFilenames: string[];
}

/** `context`'s text lowercased once for every rule `evaluateTransportRules()` checks, rather than again per rule - the body alone can be
 * `BODY_TEXT_MAX_LENGTH` characters. Lazy, so a body no rule looks at is never copied. */
function lowerContext(context: TransportRuleMatchContext): LoweredContext {
    const cache: Partial<Record<keyof LoweredContext, any>> = {};
    const once = <K extends keyof LoweredContext>(key: K, make: () => LoweredContext[K]): LoweredContext[K] => (cache[key] ??= make());
    return {
        get from() {
            return once("from", () => [context.fromAddress, ...(context.headerFromAddresses ?? [])].map((address) => address.toLowerCase()));
        },
        get subject() {
            return once("subject", () => context.subject.toLowerCase());
        },
        get body() {
            return once("body", () => (context.bodyText ?? context.bodyPreview).toLowerCase());
        },
        get recipients() {
            return once("recipients", () => [...context.recipientAddresses, ...(context.headerRecipientAddresses ?? [])].map((address) => address.toLowerCase()));
        },
        get attachmentFilenames() {
            return once("attachmentFilenames", () => context.attachmentFilenames.map((name) => name.toLowerCase()));
        },
    };
}

/**
 * Evaluates a single `TransportRule`'s `TransportRuleConditions` against `context`. Every populated
 * condition field must match (AND); a field holding an array of strings is itself OR-matched against its
 * entries - same evaluation shape as `MailFilterUtils.matchesConditions()`.
 */
export function matchesTransportRuleConditions(conditions: TransportRuleConditions, context: TransportRuleMatchContext): boolean {
    return matchesLowered(conditions, context, lowerContext(context));
}

function matchesLowered(conditions: TransportRuleConditions, context: TransportRuleMatchContext, lowered: LoweredContext): boolean {
    if (conditions.fromContains && !containsAnyInList(lowered.from, conditions.fromContains)) {
        return false;
    }
    if (conditions.subjectContains && !containsAnyIgnoreCase(lowered.subject, conditions.subjectContains)) {
        return false;
    }
    if (conditions.bodyContains && !containsAnyIgnoreCase(lowered.body, conditions.bodyContains)) {
        return false;
    }
    if (conditions.recipientContains && !containsAnyInList(lowered.recipients, conditions.recipientContains)) {
        return false;
    }
    if (conditions.anyRecipientExternal !== undefined && conditions.anyRecipientExternal !== context.anyRecipientExternal) {
        return false;
    }
    if (conditions.hasAttachment !== undefined && conditions.hasAttachment !== context.hasAttachment) {
        return false;
    }
    if (conditions.attachmentNameContains && !containsAnyInList(lowered.attachmentFilenames, conditions.attachmentNameContains)) {
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
 * A stored rule that isn't the shape evaluation reads (written before rules were validated) is skipped, reported to
 * `onUnreadable`, and the others still apply - it can't stop inbound mail, nor take every other rule with it.
 */
export function evaluateTransportRules(
    rules: TransportRule[],
    context: TransportRuleMatchContext,
    onUnreadable?: (rule: TransportRule, err: unknown) => void,
): TransportRuleEvaluationResult {
    const result: TransportRuleEvaluationResult = { reject: false, quarantine: false, addHeaders: [], addRecipients: [] };

    const sorted = rules.filter((rule) => rule.enabled).sort((a, b) => a.sequence - b.sequence);
    const lowered: LoweredContext = lowerContext(context);
    for (const rule of sorted) {
        try {
            if (!matchesLowered(rule.conditions, context, lowered)) {
                continue;
            }
            if (!Array.isArray(rule.actions)) {
                throw new Error("its actions aren't a list");
            }
        } catch (err) {
            onUnreadable?.(rule, err);
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

/** The bounds `htmlText()` converts HTML within: deeper or wider content is left out, rather than recursing without end. */
const HTML_TEXT_LIMITS = { maxDepth: 100, maxChildNodes: 10_000 };

/** `html` as plain text for `bodyContains`. */
function htmlText(html: string): string {
    return convert(html, { wordwrap: false, limits: HTML_TEXT_LIMITS });
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
    // HTML is turned into text here, bounded (`htmlText()`): mailparser's own conversion fails outright on a deeply nested body, which
    // any sender can send.
    const parsed: ParsedMail = await simpleParser(raw, { skipHtmlToText: true });

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
        : ((parsed.text
              ? parsed.text
              : typeof parsed.html === "string"
                ? htmlText(parsed.html)
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
