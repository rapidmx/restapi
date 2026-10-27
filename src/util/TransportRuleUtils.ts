///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { Parser } from "htmlparser2";
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
    /** `true` if any address in `recipientAddresses` has a domain not among this server's domains (the
     * verified ones) - precomputed by the caller (`buildTransportRuleContext()`) rather than re-derived here,
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

/** Elements whose contents are never text of the message - in HTML content. */
const HTML_SKIPPED: ReadonlySet<string> = new Set(["script", "style"]);

/** Foreign-content roots. `htmlparser2` reads a `<style>`/`<script>` inside one as raw text, as in HTML, but a browser parses its
 * contents as markup there, and an HTML element in it (`<p>`, `<div>`) breaks out of the foreign content and renders. */
const HTML_FOREIGN: ReadonlySet<string> = new Set(["svg", "math"]);

/** Elements a reader sees as a break between words. Any other element - an unknown one too, which browsers lay out inline - joins the text
 * around it, so `wi<span></span>re` still reads "wire". */
const HTML_BREAKS: ReadonlySet<string> = new Set(
    (
        "p div br hr li ul ol dl dt dd tr td th table caption thead tbody tfoot h1 h2 h3 h4 h5 h6 blockquote pre section article header " +
        "footer nav aside main address figure figcaption center form fieldset legend details summary img"
    ).split(" "),
);

/**
 * `html` as plain text for `bodyContains`, up to `BODY_TEXT_MAX_LENGTH` characters: every text node in document order, a break element a
 * space. It tokenizes (`htmlparser2`) and never builds a tree, so no nesting depth or width leaves text out - a converter that
 * recurses either fails on a deeply nested body or bounds it and drops what lies past the bound, which any sender could hide a phrase
 * behind (101 nested `<div>`s, 10,001 empty `<span>`s) while the reader's client still shows it. Comment text, and the text of a
 * `<style>`/`<script>` inside `<svg>`/`<math>`, follows the rest: a browser ends a comment where `htmlparser2` doesn't (`--!>`, a bogus
 * `<![CDATA[` comment's first `>`) and renders an HTML element inside foreign content's `<style>`, so leaving either out would hide what
 * the reader is shown. Such text is kept as it is and, read as HTML once more (`nested`), as the reader may see it: entities decoded,
 * markup a space or nothing as above. Past a `<plaintext>` start tag (outside foreign content) a browser shows the rest of the source as
 * it is, tags included, so that is what is kept, and nothing after it is read as markup.
 */
function htmlText(html: string, nested: boolean = false): string {
    const parts: string[] = [];
    // Text `htmlparser2` and a browser may read differently - a comment's (`<!-- a --!> text`, `<![CDATA[ > text`, which a browser ends
    // early), a `<style>`/`<script>`'s inside `<svg>`/`<math>` - kept after the text proper, each its own segment, so it can't split a
    // phrase the reader sees whole. Matching may see more than the reader does, never less. Read as HTML one level deep only, so no
    // nesting of comments or foreign styles recurses without bound (a deeper level is still kept as it is).
    const extra: string[] = [];
    let length: number = 0;
    let skipped: number = 0;
    let foreign: number = 0;
    let foreignRaw: number = 0;
    // Set at a `<plaintext>` start tag outside foreign content, past which a browser shows the rest of the source literally.
    let plaintext: boolean = false;
    const separate = (): void => {
        if (parts.length > 0 && parts[parts.length - 1] !== " ") {
            parts.push(" ");
            length++;
        }
    };
    const keep = (into: string[], text: string): void => {
        if (length < BODY_TEXT_MAX_LENGTH) {
            into.push(text);
            length += text.length;
        }
    };
    const keepExtra = (text: string): void => {
        keep(extra, ` ${text} `);
        if (!nested && length < BODY_TEXT_MAX_LENGTH) {
            keep(extra, ` ${htmlText(text, true)} `);
        }
    };
    const parser: Parser = new Parser(
        {
            onopentagname(name: string): void {
                if (plaintext) {
                    return;
                }
                if (HTML_FOREIGN.has(name)) {
                    foreign++;
                }
                // Nothing nests in raw text, so at most one of the two counts is ever above zero.
                if (HTML_SKIPPED.has(name)) {
                    if (foreign > 0) {
                        foreignRaw++;
                    } else {
                        skipped++;
                    }
                }
                if (HTML_BREAKS.has(name)) {
                    separate();
                }
            },
            onopentag(name: string): void {
                // A browser's tokenizer switches to its PLAINTEXT state for good at `<plaintext>`: everything after the tag, markup
                // included and entities undecoded, is shown as it is, while `htmlparser2` goes on reading it as markup (and skips a
                // `<style>` in it). Kept as the source has it, and nothing after it is read again. Inside `<svg>`/`<math>` it is just
                // a foreign element.
                if (plaintext || name !== "plaintext" || foreign > 0) {
                    return;
                }
                plaintext = true;
                separate();
                const start: number = parser.endIndex + 1;
                keep(parts, html.slice(start, start + Math.max(BODY_TEXT_MAX_LENGTH - length, 0)));
            },
            onclosetag(name: string): void {
                if (plaintext) {
                    return;
                }
                if (HTML_SKIPPED.has(name)) {
                    if (foreignRaw > 0) {
                        foreignRaw--;
                    } else if (skipped > 0) {
                        skipped--;
                    }
                }
                if (HTML_FOREIGN.has(name) && foreign > 0) {
                    foreign--;
                }
                if (HTML_BREAKS.has(name)) {
                    separate();
                }
            },
            ontext(text: string): void {
                if (plaintext) {
                    return;
                }
                if (foreignRaw > 0) {
                    keepExtra(text);
                } else if (skipped === 0) {
                    keep(parts, text);
                }
            },
            // Outside XML mode a `<![CDATA[...]]>` section is a comment too.
            oncomment(text: string): void {
                if (!plaintext) {
                    keepExtra(text);
                }
            },
        },
        { decodeEntities: true },
    );
    parser.end(html);
    return [...parts, ...extra].join("").replace(/\s+/g, " ");
}

/**
 * Builds a `TransportRuleMatchContext` from a raw RFC 5322 message and its envelope - a lightweight
 * `mailparser` parse (subject/body-preview/attachment filenames only, no spam/AV scanning), run once per
 * SMTP transaction at ingest time, before per-recipient resolution/fan-out. `domains` is this server's
 * domains, the enabled and verified `Domain` rows (`BaseMailIngestRoute` passes `getVerifiedDomainNames()`),
 * used to compute `anyRecipientExternal`.
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
