///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { convert } from "html-to-text";
import { ParsedMail, simpleParser } from "mailparser";
import { TransportRule, TransportRuleAction, TransportRuleActionType, TransportRuleConditions } from "../models/types.js";

/** The maximum length, in characters, of the plain-text body preview `buildTransportRuleContext()` derives -
 * mirrors `ScanPipeline`'s own `BODY_PREVIEW_MAX_LENGTH` constant (kept as a separate constant/parse rather
 * than shared - see the module doc comment below for why). */
const BODY_PREVIEW_MAX_LENGTH = 500;

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
    if (conditions.fromContains && !containsAnyIgnoreCase(context.fromAddress, conditions.fromContains)) {
        return false;
    }
    if (conditions.subjectContains && !containsAnyIgnoreCase(context.subject, conditions.subjectContains)) {
        return false;
    }
    if (conditions.bodyContains && !containsAnyIgnoreCase(context.bodyPreview, conditions.bodyContains)) {
        return false;
    }
    if (conditions.recipientContains && !containsAnyInList(context.recipientAddresses, conditions.recipientContains)) {
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
 */
export async function buildTransportRuleContext(
    raw: Buffer,
    envelopeFrom: string,
    envelopeTo: string[],
    domains: string[],
): Promise<TransportRuleMatchContext> {
    const parsed: ParsedMail = await simpleParser(raw);

    const bodyPreview: string =
        (typeof parsed.text === "string" ? parsed.text : typeof parsed.html === "string" ? convert(parsed.html, { wordwrap: false }) : "")
            ?.trim()
            .slice(0, BODY_PREVIEW_MAX_LENGTH) ?? "";

    const hasAttachment: boolean = (parsed.attachments ?? []).length > 0;
    const attachmentFilenames: string[] = (parsed.attachments ?? [])
        .map((attachment) => attachment.filename)
        .filter((filename): filename is string => !!filename);

    const anyRecipientExternal: boolean =
        domains.length > 0 &&
        envelopeTo.some((address) => {
            const domain = address.split("@")[1]?.toLowerCase();
            return !domain || !domains.includes(domain);
        });

    return {
        fromAddress: envelopeFrom,
        subject: parsed.subject ?? "",
        bodyPreview,
        recipientAddresses: envelopeTo,
        anyRecipientExternal,
        hasAttachment,
        attachmentFilenames,
    };
}
