///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError } from "@rapidrest/core";
import { ApiErrors, type RepoUtils } from "@rapidrest/service-core";
import { asEntity } from "./EntityUtils.js";
import { isPlainAddress } from "./MimeHeaderUtils.js";

/** The most entries one of a mailbox's sender lists (`Mailbox.blockedSenders`, `Mailbox.safeSenders`) may hold. */
export const MAX_SENDER_LIST_ENTRIES = 1000;

/** The longest entry, in characters, of a sender list (`Mailbox.blockedSenders`, `Mailbox.safeSenders`) or of a mail filter
 * rule's `fromEquals`/`fromDomainEquals` condition - RFC 5321's limit on a forward path without the angle brackets. */
export const MAX_SENDER_ENTRY_LENGTH = 254;

/** The most entries a mail filter rule's `fromEquals` or `fromDomainEquals` condition may hold. */
export const MAX_FILTER_SENDER_ENTRIES = 100;

/** A DNS host name of at least two labels (`example.com`, `mail.example.co.uk`, `xn--bcher-kva.example`): letters, digits and
 * inner hyphens, each label at most 63 characters, the whole at most 253. Lowercase input only. */
const DOMAIN_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * `value` as a lowercase domain name (`example.com`), or `undefined` when it isn't one: a string of a host name of at least two
 * labels, at most `MAX_SENDER_ENTRY_LENGTH` characters, optionally with one leading `@` (`@example.com`) and surrounding
 * whitespace, which are removed. A subdomain is a different domain: `mail.example.com` is not `example.com`.
 */
export function parseSenderDomain(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed: string = value.trim().toLowerCase();
    const domain: string = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
    return domain.length <= MAX_SENDER_ENTRY_LENGTH && DOMAIN_PATTERN.test(domain) ? domain : undefined;
}

/**
 * `value` as a lowercase plain address (`user@example.com`), or `undefined` when it isn't exactly one: no display name, angle
 * brackets, quoting, comment, list or whitespace inside (`isPlainAddress()`), at most `MAX_SENDER_ENTRY_LENGTH` characters.
 * Surrounding whitespace is removed.
 */
export function parseSenderAddress(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const address: string = value.trim().toLowerCase();
    return address.length <= MAX_SENDER_ENTRY_LENGTH && isPlainAddress(address) ? address : undefined;
}

/**
 * One entry of a sender list in its canonical form, or `undefined` when it is neither an address nor a domain: a plain address
 * stays `user@example.com` (lowercased), and a domain - written `@example.com` or `example.com` - becomes `@example.com`, so the
 * two spellings are one entry.
 */
export function parseSenderEntry(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed: string = value.trim();
    if (trimmed.startsWith("@") || !trimmed.includes("@")) {
        const domain: string | undefined = parseSenderDomain(trimmed);
        return domain === undefined ? undefined : `@${domain}`;
    }
    return parseSenderAddress(trimmed);
}

/** The domain of `address` (everything after its last `@`), lowercased; `undefined` when it has none. */
export function senderDomainOf(address: string | undefined): string | undefined {
    const at: number = address === undefined ? -1 : address.lastIndexOf("@");
    return address !== undefined && at >= 0 && at < address.length - 1 ? address.slice(at + 1).toLowerCase() : undefined;
}

/** Whether canonical sender-list `entry` (`user@example.com` or `@example.com`) names `address` (compared case-insensitively;
 * a domain entry matches that exact domain, not its subdomains). */
export function senderEntryMatches(entry: string, address: string): boolean {
    const lower: string = address.trim().toLowerCase();
    return entry.startsWith("@") ? senderDomainOf(lower) === entry.slice(1).toLowerCase() : lower === entry.toLowerCase();
}

/** Whether any entry of `list` names any of `addresses` (empty or missing values ignored). `list` may be `null`: a SQL row from
 * before the column existed. */
export function senderListMatches(list: readonly string[] | null | undefined, addresses: readonly (string | undefined | null)[]): boolean {
    const candidates: string[] = addresses.filter((address): address is string => typeof address === "string" && address.trim().length > 0);
    return (list ?? []).some((entry) => candidates.some((address) => senderEntryMatches(entry, address)));
}

const invalid = (message: string): ApiError => new ApiError(ApiErrors.INVALID_REQUEST, 400, message);

/**
 * `value` (a sender list a client wrote: `Mailbox.blockedSenders` or `Mailbox.safeSenders`) as its canonical form - every entry
 * through `parseSenderEntry()`, repeats removed, first appearance's order kept.
 *
 * @throws {ApiError} 400 when `value` isn't an array of strings, holds more than `MAX_SENDER_LIST_ENTRIES` entries (counted after
 * removing repeats), or holds an entry that is neither a plain address nor a domain of at most `MAX_SENDER_ENTRY_LENGTH` characters.
 */
export function normalizeSenderList(value: unknown, field: string): string[] {
    if (!Array.isArray(value)) {
        throw invalid(`'${field}' must be an array of addresses and domains.`);
    }
    // Bounded before any work: a request body far past the cap has nothing worth reading.
    if (value.length > MAX_SENDER_LIST_ENTRIES * 4) {
        throw invalid(`'${field}' holds more than ${MAX_SENDER_LIST_ENTRIES} entries.`);
    }
    const entries: Set<string> = new Set();
    for (const raw of value) {
        const entry: string | undefined = parseSenderEntry(raw);
        if (entry === undefined) {
            throw invalid(`'${field}' entries must each be an address (user@example.com) or a domain (@example.com) of at most ${MAX_SENDER_ENTRY_LENGTH} characters.`);
        }
        entries.add(entry);
    }
    if (entries.size > MAX_SENDER_LIST_ENTRIES) {
        throw invalid(`'${field}' holds more than ${MAX_SENDER_LIST_ENTRIES} entries.`);
    }
    return [...entries];
}

/**
 * The value of a mail filter rule's `fromEquals` (`kind: "address"`) or `fromDomainEquals` (`kind: "domain"`) condition in its
 * stored form: plain lowercase addresses, or lowercase domains without an `@`, repeats removed.
 *
 * @throws {ApiError} 400 when `value` isn't an array of strings, holds more than `MAX_FILTER_SENDER_ENTRIES` distinct entries, or
 * an entry isn't a plain address / a domain of at most `MAX_SENDER_ENTRY_LENGTH` characters.
 */
export function normalizeFilterSenderList(value: unknown, field: string, kind: "address" | "domain"): string[] {
    if (!Array.isArray(value)) {
        throw invalid(`'conditions.${field}' must be an array of ${kind === "address" ? "addresses" : "domains"}.`);
    }
    if (value.length > MAX_FILTER_SENDER_ENTRIES * 4) {
        throw invalid(`'conditions.${field}' holds more than ${MAX_FILTER_SENDER_ENTRIES} entries.`);
    }
    const entries: Set<string> = new Set();
    for (const raw of value) {
        const entry: string | undefined = kind === "address" ? parseSenderAddress(raw) : parseSenderDomain(raw);
        if (entry === undefined) {
            throw invalid(
                kind === "address"
                    ? `'conditions.${field}' entries must each be a plain address (user@example.com) of at most ${MAX_SENDER_ENTRY_LENGTH} characters.`
                    : `'conditions.${field}' entries must each be a domain (example.com) of at most ${MAX_SENDER_ENTRY_LENGTH} characters.`,
            );
        }
        entries.add(entry);
    }
    if (entries.size > MAX_FILTER_SENDER_ENTRIES) {
        throw invalid(`'conditions.${field}' holds more than ${MAX_FILTER_SENDER_ENTRIES} entries.`);
    }
    return [...entries];
}

/** The result of `moveSenderEntry()`. */
export interface SenderListsChange {
    blockedSenders: string[];
    safeSenders: string[];
    /** `true` when either list changed. */
    changed: boolean;
}

/**
 * Adds canonical `entry` to one of a mailbox's two sender lists and takes it out of the other (an entry is never on both), or
 * - `add: false` - removes it from that list only. A list already holding (or lacking) it is left as it is, `changed` says
 * whether anything moved. Never mutates its arguments.
 *
 * @throws {ApiError} 400 when the list would pass `MAX_SENDER_LIST_ENTRIES`.
 */
export function moveSenderEntry(
    lists: { blockedSenders?: readonly string[] | null; safeSenders?: readonly string[] | null },
    target: "blockedSenders" | "safeSenders",
    entry: string,
    add: boolean,
): SenderListsChange {
    const other: "blockedSenders" | "safeSenders" = target === "blockedSenders" ? "safeSenders" : "blockedSenders";
    const targetList: string[] = [...(lists[target] ?? [])];
    let otherList: string[] = [...(lists[other] ?? [])];
    let changed: boolean = false;
    if (add) {
        if (!targetList.includes(entry)) {
            if (targetList.length >= MAX_SENDER_LIST_ENTRIES) {
                throw invalid(`'${target}' already holds ${MAX_SENDER_LIST_ENTRIES} entries.`);
            }
            targetList.push(entry);
            changed = true;
        }
        if (otherList.includes(entry)) {
            otherList = otherList.filter((existing) => existing !== entry);
            changed = true;
        }
    } else if (targetList.includes(entry)) {
        targetList.splice(targetList.indexOf(entry), 1);
        changed = true;
    }
    return target === "blockedSenders"
        ? { blockedSenders: targetList, safeSenders: otherList, changed }
        : { blockedSenders: otherList, safeSenders: targetList, changed };
}

/** What the mailbox's sender lists say about one incoming message - see `evaluateSenderLists()`. */
export interface SenderListVerdict {
    /** `true` when the blocked list names the message's `From` address or its envelope sender. */
    blocked: boolean;
    /** `true` when the safe list names the message's `From` address. */
    safe: boolean;
}

/**
 * Looks a message's senders up in a mailbox's lists. The blocked list is matched against both the `From` header's address and
 * the envelope sender - either one is enough, since blocking is safe to apply on a spoofable header. The safe list is matched
 * against the `From` address only: it is the one the DKIM signature `verifiedFromAddress()` checks is aligned with, so an
 * envelope sender on the safe list is not evidence of anything and is never enough.
 */
export function evaluateSenderLists(
    lists: { blockedSenders?: readonly string[] | null; safeSenders?: readonly string[] | null },
    fromAddress: string | undefined,
    envelopeFrom: string | undefined,
): SenderListVerdict {
    return {
        blocked: senderListMatches(lists.blockedSenders, [fromAddress, envelopeFrom]),
        safe: senderListMatches(lists.safeSenders, [fromAddress]),
    };
}

/** How many times `changeMailboxSenderList()` re-reads the mailbox and tries again after losing the optimistic lock to another write. */
export const SENDER_LIST_MAX_ATTEMPTS = 5;

/**
 * Adds (`add`) or removes ONE entry of mailbox `mailboxUid`'s blocked or safe sender list, atomically: the mailbox is read uncached,
 * the change computed (`moveSenderEntry()`) and written with a version-checked update, and on losing the optimistic lock to another
 * write - a second browser tab changing the lists at the same moment - it re-reads and applies the change to what is there now (up to
 * `SENDER_LIST_MAX_ATTEMPTS` times), so two concurrent changes never overwrite each other. A change that changes nothing writes nothing.
 * The caller has already checked the caller's right to make it.
 *
 * @returns The lists as they now are, or `undefined` when the mailbox doesn't exist.
 * @throws {ApiError} 400 when the list would pass `MAX_SENDER_LIST_ENTRIES`; 409 when the lock was lost `SENDER_LIST_MAX_ATTEMPTS` times running.
 */
export async function changeMailboxSenderList(
    repo: RepoUtils<any>,
    mailboxUid: string,
    target: "blockedSenders" | "safeSenders",
    entry: string,
    add: boolean,
): Promise<SenderListsChange | undefined> {
    for (let attempt = 1; ; attempt++) {
        const existing: any = await repo.findOne(mailboxUid, { ignoreACL: true, skipCache: true });
        if (!existing) {
            return undefined;
        }
        const change: SenderListsChange = moveSenderEntry(existing, target, entry, add);
        if (!change.changed) {
            return change;
        }
        try {
            await repo.update(
                { uid: existing.uid, version: existing.version, blockedSenders: change.blockedSenders, safeSenders: change.safeSenders } as any,
                asEntity(repo, existing),
                { ignoreACL: true },
            );
            return change;
        } catch (err: any) {
            if (err?.status !== 409) {
                throw err;
            }
            if (attempt >= SENDER_LIST_MAX_ATTEMPTS) {
                throw new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "The mailbox kept changing while its sender list was being updated. Try again.");
            }
        }
    }
}
