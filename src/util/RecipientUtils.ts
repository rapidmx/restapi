///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { normalizeAddress } from "./AddressUtils.js";
import { Recipient, RecipientType } from "../models/types.js";

/**
 * Turns the already-parsed `From`/`To`/`Cc`/`Bcc` headers of a message (`mailparser`'s `ParsedMail`, via
 * `ScanPipelineResult`) into the `Recipient` rows a delivered `Message` stores - so a delivered copy records
 * *everyone* the message was addressed to, not just the SMTP envelope recipient whose mailbox it was filed
 * into (which is all `ScanQueueJob` used to record, leaving Reply All, conversation views and every
 * server-side reader of `Message.recipients` with a one-entry list).
 *
 * Nothing here parses raw header text itself: `ScanPipeline` already runs one full MIME parse per message and
 * `mailparser` has already split the address lists, RFC 2047-decoded each display name and expanded any group
 * syntax by the time these functions see it. They only bound, clean and de-duplicate what came back - so a
 * huge or hostile header adds no new parsing (and no new regular expression) to the ingest path at all.
 */

/**
 * How many recipients one delivered message records. A `To`/`Cc` header has no length limit of its own, and
 * nothing downstream (Reply All, the reading pane, the search index's participant list) is usefully served by
 * an unbounded list - past this the remaining header recipients are dropped. Envelope recipients are never
 * dropped: see `buildDeliveredRecipients()`.
 */
export const MAX_MESSAGE_RECIPIENTS = 100;

/** RFC 5321's address length limit - anything longer isn't a deliverable address, so it isn't stored as one. */
const MAX_ADDRESS_LENGTH = 320;

/** How much of a display name is stored. Nothing renders more than a line of it, and a header can carry megabytes. */
const MAX_DISPLAY_NAME_LENGTH = 200;

/** How deep a nested address group is followed. RFC 5322 doesn't allow a group inside a group; a parser that
 * reports one anyway can't make this walk unbounded. */
const MAX_GROUP_DEPTH = 5;

/** Whether `code` is a C0 control character or DEL - never kept in a stored address or display name (a stray
 * CR/LF would end up in a composed header downstream). Scanned by character code rather than matched by a
 * regular expression, the same way `MimeHeaderUtils.ts` does it. */
function isControlCharacterCode(code: number): boolean {
    return code < 0x20 || code === 0x7f;
}

/** Whether `value` holds a control character. */
function hasControlCharacter(value: string): boolean {
    for (let i = 0; i < value.length; i++) {
        if (isControlCharacterCode(value.charCodeAt(i))) {
            return true;
        }
    }
    return false;
}

/** `value` with every control character replaced by a space. */
function replaceControlCharacters(value: string): string {
    let result: string = "";
    for (const character of value) {
        result += isControlCharacterCode(character.charCodeAt(0)) ? " " : character;
    }
    return result;
}

/** One parsed address-header entry, exactly the shape `mailparser` reports (`AddressObject.value[]`): either an
 * address with an optional decoded display name, or a group whose members are in `group`. */
export interface ParsedAddressEntry {
    address?: string;
    name?: string;
    group?: ParsedAddressEntry[];
}

/** One parsed address header - `mailparser`'s `AddressObject`, or the array it reports when the same header
 * occurs more than once. */
export type ParsedAddressHeader =
    | { value?: ParsedAddressEntry[] }
    | { value?: ParsedAddressEntry[] }[]
    | undefined;

/** The entries of one parsed address header, groups expanded in place, stopping once `limit` entries carrying an
 * address have been collected (so a header naming a million recipients costs `limit` entries of work, not a
 * million). */
function collectEntries(header: ParsedAddressHeader, limit: number): ParsedAddressEntry[] {
    const collected: ParsedAddressEntry[] = [];
    const visit = (entries: ParsedAddressEntry[], depth: number): void => {
        for (const entry of entries) {
            if (collected.length >= limit) {
                return;
            }
            if (Array.isArray(entry?.group)) {
                if (depth < MAX_GROUP_DEPTH) {
                    visit(entry.group, depth + 1);
                }
                continue;
            }
            if (entry) {
                collected.push(entry);
            }
        }
    };
    for (const one of Array.isArray(header) ? header : header ? [header] : []) {
        if (collected.length >= limit) {
            break;
        }
        visit(one?.value ?? [], 0);
    }
    return collected;
}

/**
 * `value` as a stored `Recipient.address` - exactly as the parser reported it, only trimmed - or `undefined`
 * when it isn't usable as one: not a string, empty, longer than RFC 5321's limit, carrying a control character,
 * or not even `@`-shaped.
 */
export function storedAddress(value: unknown): string | undefined {
    if (typeof value !== "string" || value.length > MAX_ADDRESS_LENGTH) {
        return undefined;
    }
    const trimmed: string = value.trim();
    if (trimmed.length === 0 || !trimmed.includes("@") || hasControlCharacter(trimmed)) {
        return undefined;
    }
    return trimmed;
}

/**
 * `name` as a stored `Recipient.displayName`: RFC 2047 decoding has already happened (`mailparser`), so this
 * only removes control characters, collapses whitespace, trims and caps the length - `undefined` when nothing
 * is left.
 *
 * Deliberately *not* `MimeHeaderUtils.safeDisplayName()`, which drops a name containing an `@`: that rule is
 * for a name this server puts in front of one of its *own* addresses in a header it composes. Here the name is
 * what an inbound sender chose to show the reader, and a client's "this sender's name looks like an address"
 * phishing warning needs to see it (see `web-client`'s `MessageDetailPane.checkSenderName()`).
 */
export function storedDisplayName(name: unknown): string | undefined {
    if (typeof name !== "string") {
        return undefined;
    }
    const clean: string = replaceControlCharacters(name).replace(/ {2,}/g, " ").trim().slice(0, MAX_DISPLAY_NAME_LENGTH).trim();
    return clean.length > 0 ? clean : undefined;
}

/** One `Recipient` from a parsed entry, or `undefined` when it names no usable address. */
function toRecipient(entry: ParsedAddressEntry, type: RecipientType): Recipient | undefined {
    const address: string | undefined = storedAddress(entry.address);
    if (!address) {
        return undefined;
    }
    const displayName: string | undefined = storedDisplayName(entry.name);
    return displayName ? { address, displayName, type } : { address, type };
}

/**
 * The recipients a message's own headers name: `To` as `to`, `Cc` as `cc` and any `Bcc` **present on this copy**
 * as `bcc` - de-duplicated case-insensitively by address (first occurrence, so `To` wins over `Cc`) and capped at
 * `limit`. Display names are kept as the sender wrote them (decoded).
 *
 * A delivered copy normally carries no `Bcc` header at all - the submitting client strips it and the envelope is
 * what actually addressed the copy - so nothing here ever *invents* a bcc entry for another recipient. A `Bcc`
 * header is only honored when the stored copy genuinely has one (a mailbox's own Sent Items copy, or a sender
 * whose MTA left the header on the recipient's copy).
 */
export function parseHeaderRecipients(
    parsed: { to?: ParsedAddressHeader; cc?: ParsedAddressHeader; bcc?: ParsedAddressHeader },
    limit: number = MAX_MESSAGE_RECIPIENTS,
): Recipient[] {
    const recipients: Recipient[] = [];
    const seen: Set<string> = new Set();
    const headers: [ParsedAddressHeader, RecipientType][] = [
        [parsed.to, RecipientType.TO],
        [parsed.cc, RecipientType.CC],
        [parsed.bcc, RecipientType.BCC],
    ];
    for (const [header, type] of headers) {
        for (const entry of collectEntries(header, limit)) {
            const recipient: Recipient | undefined = toRecipient(entry, type);
            if (!recipient) {
                continue;
            }
            const key: string = normalizeAddress(recipient.address);
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            recipients.push(recipient);
            if (recipients.length >= limit) {
                return recipients;
            }
        }
    }
    return recipients;
}

/**
 * The `Message.recipients` of a copy delivered to one mailbox: every recipient the message's own headers name
 * (`parseHeaderRecipients()`), plus any SMTP envelope recipient no header mentions.
 *
 * An envelope recipient absent from every header is one that was bcc'd, reached through an alias, or expanded
 * from a distribution list - it is recorded as `bcc`, which is what it is from this copy's point of view: it was
 * addressed privately, and a client building Reply All must not put it back on a visible header (nor may
 * dropping it lose the fact that this mailbox received the message at all). Envelope entries are therefore kept
 * even when the header list already fills `limit`, displacing the last header recipients instead of being
 * dropped themselves.
 *
 * Addresses are de-duplicated case-insensitively (`normalizeAddress()`) but stored exactly as parsed.
 */
export function buildDeliveredRecipients(
    headerRecipients: Recipient[] | undefined,
    envelopeTo: string[] | undefined,
    limit: number = MAX_MESSAGE_RECIPIENTS,
): Recipient[] {
    const fromHeaders: Recipient[] = [];
    const seen: Set<string> = new Set();
    for (const recipient of headerRecipients ?? []) {
        const address: string | undefined = storedAddress(recipient?.address);
        if (!address) {
            continue;
        }
        const key: string = normalizeAddress(address);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        const displayName: string | undefined = storedDisplayName(recipient.displayName);
        fromHeaders.push(displayName ? { address, displayName, type: recipient.type } : { address, type: recipient.type });
        if (fromHeaders.length >= limit) {
            break;
        }
    }
    const fromEnvelope: Recipient[] = [];
    for (const value of envelopeTo ?? []) {
        const address: string | undefined = storedAddress(value);
        if (!address) {
            continue;
        }
        const key: string = normalizeAddress(address);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        fromEnvelope.push({ address, type: RecipientType.BCC });
        if (fromEnvelope.length >= limit) {
            break;
        }
    }
    return [...fromHeaders.slice(0, Math.max(0, limit - fromEnvelope.length)), ...fromEnvelope];
}

/**
 * The display name alone from a parsed `From` header - unquoted and RFC 2047-decoded (`mailparser` does both),
 * control characters removed and capped. `undefined` when the sender gave no name.
 *
 * This is what `Message.from.displayName` stores: the whole header value used to go in there, so a sender
 * rendered as `"Bob Allen" <bob@partner.test> <bob@partner.test>` once a client put the name in front of the
 * address itself.
 */
export function parseSenderDisplayName(from: ParsedAddressHeader): string | undefined {
    return storedDisplayName(collectEntries(from, 1)[0]?.name);
}
