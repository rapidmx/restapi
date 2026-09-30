///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ModelUtils, RepoUtils, type ObjectFactory } from "@rapidrest/service-core";
import { CorrespondentSource, FolderType, Mailbox } from "../models/types.js";
import { normalizeAddress } from "./AddressUtils.js";
import { asEntity } from "./EntityUtils.js";
import { isDuplicateKeyError } from "./RequestBodyUtils.js";

/**
 * Keeps each mailbox's `Correspondent` list - everyone it has exchanged mail or calendar invitations with - up to
 * date, for `GET /mail/directory/correspondents` (recipient suggestions). Three entry points:
 *
 * - `recordCorrespondents()`: called from the choke points where mail or events enter a mailbox (`ScanQueueJob` for
 * delivered mail and received invitations, `BaseMessageRoute.send()`/`ScheduledSendJob` for sent mail,
 * `BaseCalendarEventRoute` for events a user creates or edits). It NEVER throws: suggestions are a convenience, and a
 * failure to record one must not fail a delivery, a send or an event save.
 * - `ensureCorrespondentsBackfilled()`: builds the list for a mailbox that predates this feature from its existing
 * messages and events, once (see its doc comment).
 * - `mergeCorrespondentObservations()`: the pure part of both, exported so it can be tested on its own.
 *
 * Nothing here filters obvious non-people (`noreply@`, list addresses, ...): the suggestions are typed against, so
 * they cost nothing until someone types their prefix, and a heuristic would hide real addresses.
 */

/** How many distinct addresses one `recordCorrespondents()` call records at most. A `To`/`Cc` header has no limit of
 * its own (`MAX_MESSAGE_RECIPIENTS` bounds what a delivered message stores), and each address is a write. */
export const CORRESPONDENT_MAX_PER_CALL = 100;
/** The longest address recorded: RFC 5321's limit for a forward path (256) less its angle brackets. Also keeps the
 * (mailboxUid, address) unique index within a MySQL/MariaDB key. */
export const CORRESPONDENT_MAX_ADDRESS_LENGTH = 254;
/** How much of a display name is kept. */
export const CORRESPONDENT_MAX_NAME_LENGTH = 200;
/** How many of a mailbox's most recent messages the backfill reads. */
export const CORRESPONDENT_BACKFILL_MAX_MESSAGES = 2000;
/** How many of a mailbox's most recently modified calendar events the backfill reads. */
export const CORRESPONDENT_BACKFILL_MAX_EVENTS = 500;
/** How many distinct addresses the backfill records, most recently seen first. */
export const CORRESPONDENT_BACKFILL_MAX_ADDRESSES = 500;
/** How many folders the backfill reads to find the ones to leave out. */
const BACKFILL_MAX_FOLDERS = 500;
/** How often one address's write is retried after losing a race with another writer. */
const MAX_WRITE_ATTEMPTS = 3;

/** Folders whose mail says nothing about who the user corresponds with: unsolicited mail and unsent or discarded mail. */
const BACKFILL_EXCLUDED_FOLDER_TYPES: ReadonlySet<string> = new Set([FolderType.JUNK, FolderType.DRAFTS, FolderType.DELETED_ITEMS, FolderType.OUTBOX]);

/** A plain `local@domain` address: no whitespace, angle brackets, quotes, commas or semicolons, one `@`, a dotted domain. */
const PLAIN_ADDRESS = /^[^\s@<>",;:\\()[\]]+@[^\s@<>",;:\\()[\]]+\.[^\s@<>",;:\\()[\]]+$/;

/** The parts of a `Mailbox` that decide which addresses are its own. */
export type CorrespondentMailbox = Pick<Mailbox, "uid" | "primarySmtpAddress" | "aliasAddresses"> & Partial<Pick<Mailbox, "correspondentsBackfilledAt">>;

/** What the functions here need to reach the datastore. `mailboxClass` is only used to look a mailbox up by uid and the
 * backfill's three classes only by `ensureCorrespondentsBackfilled()`. */
export interface CorrespondentContext {
    objectFactory: ObjectFactory;
    correspondentClass: any;
    mailboxClass: any;
    logger?: any;
}

/** `CorrespondentContext` plus the classes the backfill reads. */
export interface CorrespondentBackfillContext extends CorrespondentContext {
    messageClass: any;
    folderClass: any;
    calendarEventClass: any;
}

/** One sighting of an address. `count` and `seenAt` default to one time, now; the backfill passes both for a history. */
export interface CorrespondentObservation {
    address?: string | null;
    displayName?: string | null;
    seenAt?: Date;
    /** How many times it was seen. Left out, the address counts once per merge however often it is listed. */
    count?: number;
    /** Overrides the merge's default source for this sighting. */
    source?: CorrespondentSource;
}

/** The result of merging every sighting of one address. */
export interface MergedCorrespondent {
    displayName: string;
    seenAt: Date;
    count: number;
    source: CorrespondentSource;
}

/** `value` as a valid `Date` (a stored date can come back as an ISO string), or `undefined`. */
function toDate(value: unknown): Date | undefined {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }
    const date: Date = value instanceof Date ? value : new Date(value as any);
    return Number.isNaN(date.getTime()) ? undefined : date;
}

/** `name` trimmed, control characters and doubled whitespace collapsed to one space, and cut to `CORRESPONDENT_MAX_NAME_LENGTH`. */
function cleanName(name: string | null | undefined): string {
    if (typeof name !== "string") {
        return "";
    }
    let result: string = "";
    for (const character of name) {
        result += character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f ? " " : character;
    }
    return result.replace(/\s+/g, " ").trim().slice(0, CORRESPONDENT_MAX_NAME_LENGTH);
}

/** The lowercased `address` if it is one plain, deliverable-looking address; otherwise `undefined`. */
export function cleanCorrespondentAddress(address: unknown): string | undefined {
    if (typeof address !== "string") {
        return undefined;
    }
    const normalized: string = normalizeAddress(address);
    return normalized.length <= CORRESPONDENT_MAX_ADDRESS_LENGTH && PLAIN_ADDRESS.test(normalized) ? normalized : undefined;
}

/**
 * Merges `observations` into one entry per address, skipping the mailbox's own primary address and aliases, and
 * anything that is not one plain address. Per address: `seenAt` is the latest sighting, `displayName` the name from the
 * latest sighting that had one (later in the list wins a tie), `source` that of the latest sighting, and `count` the sum
 * of the explicit counts plus one if any sighting gave none. At most `maxAddresses` distinct addresses are kept - the
 * first ones in `observations`' order, so a caller that wants the newest sorts them first.
 */
export function mergeCorrespondentObservations(
    mailbox: Pick<Mailbox, "primarySmtpAddress" | "aliasAddresses">,
    observations: CorrespondentObservation[],
    defaultSource: CorrespondentSource,
    now: Date,
    maxAddresses: number = CORRESPONDENT_MAX_PER_CALL,
): Map<string, MergedCorrespondent> {
    const own = new Set<string>([mailbox.primarySmtpAddress, ...(mailbox.aliasAddresses ?? [])].map((address) => normalizeAddress(String(address ?? ""))));
    const merged = new Map<string, MergedCorrespondent>();
    const implicit = new Set<string>();
    // The time of the sighting each address's name came from - a name is replaced only by one from a later sighting.
    const nameSeenAt = new Map<string, number>();
    for (const observation of observations) {
        const address: string | undefined = cleanCorrespondentAddress(observation?.address);
        if (!address || own.has(address)) {
            continue;
        }
        const seenAt: Date = toDate(observation.seenAt) ?? now;
        const name: string = cleanName(observation.displayName);
        const explicit: number | undefined =
            typeof observation.count === "number" && Number.isFinite(observation.count) && observation.count > 0 ? Math.floor(observation.count) : undefined;
        let entry: MergedCorrespondent | undefined = merged.get(address);
        if (!entry) {
            if (merged.size >= maxAddresses) {
                continue;
            }
            entry = { displayName: "", seenAt, count: 0, source: observation.source ?? defaultSource };
            merged.set(address, entry);
        }
        if (explicit === undefined) {
            implicit.add(address);
        } else {
            entry.count += explicit;
        }
        if (seenAt.getTime() >= entry.seenAt.getTime()) {
            entry.seenAt = seenAt;
            entry.source = observation.source ?? defaultSource;
        }
        if (name && seenAt.getTime() >= (nameSeenAt.get(address) ?? -Infinity)) {
            entry.displayName = name;
            nameSeenAt.set(address, seenAt.getTime());
        }
    }
    for (const address of implicit) {
        merged.get(address)!.count += 1;
    }
    return merged;
}

/** Writes `merged` for `address` into `mailboxUid`: creates the row, or updates the one `existing` names (a stale
 * `existing`, or a create that lost the race to another writer, is retried against a fresh read). */
async function upsertCorrespondent(
    context: CorrespondentContext,
    repo: RepoUtils<any>,
    mailboxUid: string,
    address: string,
    merged: MergedCorrespondent,
    existing: any,
): Promise<void> {
    let row: any = existing;
    for (let attempt = 1; ; attempt++) {
        try {
            if (row) {
                // A sighting older than the row's last one adds to the count but changes nothing about who they are now.
                const newer: boolean = merged.seenAt.getTime() >= (toDate(row.lastSeenAt)?.getTime() ?? 0);
                await repo.update(
                    {
                        uid: row.uid,
                        version: row.version,
                        count: (Number(row.count) || 0) + merged.count,
                        ...(newer ? { lastSeenAt: merged.seenAt, lastSource: merged.source, displayName: merged.displayName || row.displayName || "" } : {}),
                    },
                    asEntity(repo, row),
                    { ignoreACL: true },
                );
            } else {
                await repo.create(
                    new context.correspondentClass({
                        mailboxUid,
                        address,
                        displayName: merged.displayName,
                        lastSeenAt: merged.seenAt,
                        count: merged.count,
                        lastSource: merged.source,
                    }),
                    { ignoreACL: true },
                );
            }
            return;
        } catch (err: any) {
            if (attempt >= MAX_WRITE_ATTEMPTS || !(err?.status === 409 || isDuplicateKeyError(err))) {
                throw err;
            }
        }
        row = (
            await repo.find({ mailboxUid: ModelUtils.literal(mailboxUid), address: ModelUtils.literal(address), limit: 1 } as any, {
                ignoreACL: true,
                limit: 1,
                skipCache: true,
            })
        )[0];
    }
}

/** Upserts every entry of `merged` into `mailboxUid`'s correspondents: one read of the existing rows, then a write per
 * address (`RepoUtils` has no bulk write). The writes are made one at a time, not concurrently: on a single-connection SQL
 * driver (SQLite) overlapping writes fail each other's transactions. One address failing is logged and doesn't stop the rest. */
async function upsertAll(context: CorrespondentContext, mailboxUid: string, merged: Map<string, MergedCorrespondent>): Promise<void> {
    if (merged.size === 0) {
        return;
    }
    const repo: RepoUtils<any> = await context.objectFactory.newInstance(RepoUtils, {
        name: context.correspondentClass.name,
        args: [context.correspondentClass],
    });
    const addresses: string[] = [...merged.keys()];
    const found: any[] = await repo.find(
        { mailboxUid: ModelUtils.literal(mailboxUid), address: ModelUtils.literal(addresses, "in"), limit: addresses.length } as any,
        { ignoreACL: true, limit: addresses.length, skipCache: true },
    );
    const existing = new Map<string, any>(found.map((row) => [row.address, row]));
    for (const address of addresses) {
        try {
            await upsertCorrespondent(context, repo, mailboxUid, address, merged.get(address)!, existing.get(address));
        } catch (err: any) {
            context.logger?.warn(`CorrespondentUtils: could not record ${address} for mailbox ${mailboxUid}: ${err?.message}`);
        }
    }
}

/** The mailbox `mailboxUid`, or `undefined` if there is none. */
async function loadMailbox(context: CorrespondentContext, mailboxUid: string): Promise<any> {
    const mailboxRepo: RepoUtils<any> = await context.objectFactory.newInstance(RepoUtils, {
        name: context.mailboxClass.name,
        args: [context.mailboxClass],
    });
    return await mailboxRepo.findOne(mailboxUid, { ignoreACL: true });
}

/**
 * Records that `mailbox` encountered `observations` (by `source`): for each distinct address, lowercased, creates its
 * `Correspondent` or - keeping the name of the latest sighting that had one - adds one to its `count`, moves
 * `lastSeenAt` forward and sets `lastSource`. The mailbox's own primary address and aliases and anything that is not a
 * plain address are skipped, and at most `CORRESPONDENT_MAX_PER_CALL` addresses are recorded per call.
 *
 * `mailbox` is the mailbox, or just its uid (loaded here; a mailbox that has gone records nothing). Never throws: a
 * failure is logged as a warning, since this is called from delivery, sending and event saving, none of which may fail
 * over a suggestion. Cheap: one read of the addresses' existing rows and one write per address.
 */
export async function recordCorrespondents(
    context: CorrespondentContext,
    mailbox: CorrespondentMailbox | string,
    observations: CorrespondentObservation[],
    source: CorrespondentSource,
): Promise<void> {
    try {
        if (observations.length === 0) {
            return;
        }
        const identity: CorrespondentMailbox | undefined = typeof mailbox === "string" ? await loadMailbox(context, mailbox) : mailbox;
        if (!identity) {
            return;
        }
        await upsertAll(context, identity.uid, mergeCorrespondentObservations(identity, observations, source, new Date()));
    } catch (err: any) {
        context.logger?.warn(`CorrespondentUtils: could not record correspondents: ${err?.message}`);
    }
}

/** The sightings on a message: `from` and every recipient. `from` is the sender, whose name is what they call themselves. */
export function messageObservations(
    message: { from?: { address?: string; displayName?: string }; recipients?: { address?: string; displayName?: string; type?: string }[] },
    include: { from: boolean; types: readonly string[] },
): CorrespondentObservation[] {
    const observations: CorrespondentObservation[] = [];
    if (include.from && message.from) {
        observations.push({ address: message.from.address, displayName: message.from.displayName });
    }
    for (const recipient of message.recipients ?? []) {
        if (include.types.includes(recipient?.type ?? "to")) {
            observations.push({ address: recipient?.address, displayName: recipient?.displayName });
        }
    }
    return observations;
}

/** The sightings on a calendar event: its organizer and attendees. */
export function eventObservations(event: {
    organizer?: { address?: string; displayName?: string };
    attendees?: { address?: string; displayName?: string }[];
}): CorrespondentObservation[] {
    return [event.organizer, ...(event.attendees ?? [])].map((person) => ({ address: person?.address, displayName: person?.displayName }));
}

/**
 * Builds `mailbox`'s correspondents from what it already holds - the From and recipients of its most recent
 * `CORRESPONDENT_BACKFILL_MAX_MESSAGES` messages (leaving out Junk, Drafts, Deleted Items and Outbox; a message the
 * mailbox sent contributes its recipients, any other its sender, To and Cc) and the organizer and attendees of its
 * `CORRESPONDENT_BACKFILL_MAX_EVENTS` most recently modified events - keeping the `CORRESPONDENT_BACKFILL_MAX_ADDRESSES`
 * most recently seen addresses. One sighting per message or event, dated by when the message arrived or the event was
 * last changed.
 *
 * Design: run on demand, the first time a mailbox is searched (`BaseDirectoryRoute.searchCorrespondents()`), rather than
 * by a job. It is bounded, so it fits in a request (three bounded reads and at most 500 writes, one at a time), needs no
 * scheduler or per-deployment wiring, and only mailboxes that use recipient suggestions ever pay for it. The marker is
 * `Mailbox.correspondentsBackfilledAt`, written BEFORE the work starts with a version-checked update, so of two searches
 * racing on a fresh mailbox only one backfills (history is never counted twice); if the work then fails the marker is
 * cleared again so the next search retries. Correspondents recorded live in the meantime are simply added to.
 *
 * Never throws (a failure is logged). Resolves once the backfill has finished, or straight away if the mailbox was
 * already backfilled or another request holds the claim.
 */
export async function ensureCorrespondentsBackfilled(context: CorrespondentBackfillContext, mailbox: CorrespondentMailbox): Promise<void> {
    if (mailbox.correspondentsBackfilledAt) {
        return;
    }
    try {
        const mailboxRepo: RepoUtils<any> = await context.objectFactory.newInstance(RepoUtils, {
            name: context.mailboxClass.name,
            args: [context.mailboxClass],
        });
        const row: any = await mailboxRepo.findOne(mailbox.uid, { ignoreACL: true, skipCache: true });
        if (!row || row.correspondentsBackfilledAt) {
            return;
        }
        try {
            await mailboxRepo.update({ uid: row.uid, version: row.version, correspondentsBackfilledAt: new Date() } as any, asEntity(mailboxRepo, row), {
                ignoreACL: true,
            });
        } catch (err: any) {
            // Another search claimed the backfill first (a version conflict) - it is theirs to do.
            context.logger?.debug?.(`CorrespondentUtils: backfill of mailbox ${mailbox.uid} claimed elsewhere: ${err?.message}`);
            return;
        }
        try {
            await backfill(context, row);
        } catch (err: any) {
            context.logger?.warn(`CorrespondentUtils: backfill of mailbox ${mailbox.uid} failed: ${err?.message}`);
            await releaseBackfillClaim(mailboxRepo, mailbox.uid);
        }
    } catch (err: any) {
        context.logger?.warn(`CorrespondentUtils: could not check whether mailbox ${mailbox.uid} needs a backfill: ${err?.message}`);
    }
}

/** Clears the marker `ensureCorrespondentsBackfilled()` set, so a failed backfill is attempted again. Best-effort. */
async function releaseBackfillClaim(mailboxRepo: RepoUtils<any>, mailboxUid: string): Promise<void> {
    try {
        const current: any = await mailboxRepo.findOne(mailboxUid, { ignoreACL: true, skipCache: true });
        if (current) {
            await mailboxRepo.update({ uid: current.uid, version: current.version, correspondentsBackfilledAt: null } as any, asEntity(mailboxRepo, current), {
                ignoreACL: true,
            });
        }
        /* v8 ignore start -- only a second failure while releasing */
    } catch {
        // The marker stays set: this mailbox's suggestions then only ever come from live mail.
    }
    /* v8 ignore stop */
}

/** The reads and writes of `ensureCorrespondentsBackfilled()`. */
async function backfill(context: CorrespondentBackfillContext, mailbox: CorrespondentMailbox): Promise<void> {
    const repoFor = async (clazz: any): Promise<RepoUtils<any>> =>
        await context.objectFactory.newInstance(RepoUtils, { name: clazz.name, args: [clazz] });
    const [folderRepo, messageRepo, eventRepo] = await Promise.all([repoFor(context.folderClass), repoFor(context.messageClass), repoFor(context.calendarEventClass)]);
    const own = new Set<string>([mailbox.primarySmtpAddress, ...(mailbox.aliasAddresses ?? [])].map((address) => normalizeAddress(String(address ?? ""))));

    const folders: any[] = await folderRepo.find({ mailboxUid: ModelUtils.literal(mailbox.uid), limit: BACKFILL_MAX_FOLDERS } as any, {
        ignoreACL: true,
        limit: BACKFILL_MAX_FOLDERS,
    });
    const excluded = new Set<string>(folders.filter((folder) => BACKFILL_EXCLUDED_FOLDER_TYPES.has(folder.type)).map((folder) => folder.uid));
    const messages: any[] = await messageRepo.find(
        { mailboxUid: ModelUtils.literal(mailbox.uid), sort: { receivedDate: "DESC" }, limit: CORRESPONDENT_BACKFILL_MAX_MESSAGES } as any,
        { ignoreACL: true, limit: CORRESPONDENT_BACKFILL_MAX_MESSAGES },
    );
    const events: any[] = await eventRepo.find(
        { mailboxUid: ModelUtils.literal(mailbox.uid), sort: { dateModified: "DESC" }, limit: CORRESPONDENT_BACKFILL_MAX_EVENTS } as any,
        { ignoreACL: true, limit: CORRESPONDENT_BACKFILL_MAX_EVENTS },
    );

    const observations: CorrespondentObservation[] = [];
    for (const message of messages) {
        if (excluded.has(message.folderUid)) {
            continue;
        }
        const seenAt: Date | undefined = toDate(message.receivedDate) ?? toDate(message.sentDate) ?? toDate(message.dateCreated);
        const sent: boolean = own.has(normalizeAddress(String(message.from?.address ?? "")));
        const source: CorrespondentSource = sent ? "sent" : "received";
        for (const observation of messageObservations(message, { from: !sent, types: sent ? ["to", "cc", "bcc"] : ["to", "cc"] })) {
            observations.push({ ...observation, seenAt, count: 1, source });
        }
    }
    for (const event of events) {
        const seenAt: Date | undefined = toDate(event.dateModified) ?? toDate(event.dateCreated);
        for (const observation of eventObservations(event)) {
            observations.push({ ...observation, seenAt, count: 1, source: "event" });
        }
    }
    // Every message and event above is one sighting (`count: 1` explicitly, so an address on many of them counts them all);
    // newest first, so the address cap keeps the most recently seen.
    observations.sort((a, b) => (b.seenAt?.getTime() ?? 0) - (a.seenAt?.getTime() ?? 0));
    await upsertAll(context, mailbox.uid, mergeCorrespondentObservations(mailbox, observations, "received", new Date(), CORRESPONDENT_BACKFILL_MAX_ADDRESSES));
}

