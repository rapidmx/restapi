///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, type JWTUser } from "@rapidrest/core";
import { ACLAction, ApiErrors, ModelUtils, type RepoUtils } from "@rapidrest/service-core";
import { CalendarEvent, FolderType, type FreeBusyVisibility, type Mailbox } from "../models/types.js";
import { normalizeAddress } from "./AddressUtils.js";
import { computeBusyIntervals, mergeBusyIntervals, type BusyInterval } from "./FreeBusyUtils.js";
import { mailboxAddressSet } from "./MeetingInviteUtils.js";
import { isPlainAddress } from "./MimeHeaderUtils.js";
import { findMailboxByAddress } from "./PrincipalResolutionUtils.js";

/**
 * "Find a time": the busy windows of other people's calendars, for `POST /calendar-events/free-busy`. The route is
 * `BaseCalendarEventRoute.freeBusy()`; everything that is not HTTP is here.
 *
 * What may be learned: each mailbox's OWNER decides who may see its free/busy (`Mailbox.freeBusyVisibility`), and what is
 * shared is never more than the windows - no title, location, attendee, organizer or event count. Private and
 * confidential events count as busy like any other.
 *
 * **Unknown versus restricted.** An address that is not a local mailbox (or alias) is `unknown`. A mailbox whose
 * visibility does not admit the caller is `restricted` - but only to a caller who could find out the mailbox exists
 * anyway: the address directory (`GET /mail/directory`) lists every mailbox to any user who owns one on this server (or
 * holds a trusted role), so for such a caller `restricted` reveals nothing new. A caller who owns no mailbox here - an
 * identity from the shared auth service that has never been provisioned - could not resolve the address through the
 * directory (403), so for them a mailbox they may not see reads as `unknown`, exactly like a missing one: this endpoint
 * is not an existence oracle the directory is not. (A mailbox that is `everyone` is visible to any signed-in caller by
 * its owner's own choice, and so is reported to them.)
 */

/** The values of `Mailbox.freeBusyVisibility`. */
export const FREE_BUSY_VISIBILITIES: readonly FreeBusyVisibility[] = ["domain", "shared", "nobody", "everyone"];

/** What a mailbox with no stored `freeBusyVisibility` (one written before the field existed) reads as. */
export const DEFAULT_FREE_BUSY_VISIBILITY: FreeBusyVisibility = "domain";

/** Most addresses one request may ask about. */
export const FREE_BUSY_MAX_ADDRESSES = 50;
/** Longest window one request may ask about: 31 days. */
export const FREE_BUSY_MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
/** Requests one signed-in caller may make per `FREE_BUSY_WINDOW_SECONDS` - a "Find a time" view asks again on each change of
 * attendee or day, debounced; 60 a minute is a request a second, far above a person and a hard bound on a script. */
export const FREE_BUSY_MAX_ATTEMPTS = 60;
export const FREE_BUSY_WINDOW_SECONDS = 60;
/**
 * The bounds on reading one mailbox's calendar: rows per page, pages per query (2000 rows per query, three queries) and merged
 * windows per address. A mailbox with more overlapping events, recurring series or moved occurrences than that - or more
 * windows - is reported `unknown` rather than as free time the server did not check. Fields, not constants, only so a test can
 * lower them; nothing else writes them.
 */
export const FREE_BUSY_LIMITS = { pageSize: 500, maxPages: 4, maxWindows: 500 };
/** Most calendar folders of one mailbox read. */
export const FREE_BUSY_MAX_FOLDERS = 50;
/** How many addresses are looked up (and their calendars read) at a time. */
const LOOKUP_CONCURRENCY = 5;
/** A moved occurrence's original time can be up to this long before the window and still be its master's `recurrenceId`
 * to exclude (`ScanQueueJob`'s `RESOURCE_BOOKING_OVERRIDE_LOOKBACK_MS`). */
const OVERRIDE_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** The ACL action a `CalendarShareLink` for free/busy only grants - see `CalendarShareLink.permittedActions`. */
const FREE_BUSY_ACTION = "freebusy";
/** The access that lets a caller read (or see the free/busy of) a calendar: what "shared" means. */
const SHARED_ACTIONS: readonly string[] = [ACLAction.READ, ACLAction.LIST, FREE_BUSY_ACTION];

/** Whether `value` is one of `FREE_BUSY_VISIBILITIES`. */
export function isFreeBusyVisibility(value: unknown): value is FreeBusyVisibility {
    return typeof value === "string" && (FREE_BUSY_VISIBILITIES as readonly string[]).includes(value);
}

/** `mailbox`'s visibility, `domain` for a row that has none (absent on Mongo, `null` on SQL). */
export function effectiveFreeBusyVisibility(mailbox: Pick<Mailbox, "freeBusyVisibility">): FreeBusyVisibility {
    return mailbox.freeBusyVisibility ?? DEFAULT_FREE_BUSY_VISIBILITY;
}

/** Refuses (400) a `freeBusyVisibility` that is not one of `FREE_BUSY_VISIBILITIES`. */
export function assertFreeBusyVisibility(value: unknown): asserts value is FreeBusyVisibility {
    if (!isFreeBusyVisibility(value)) {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'freeBusyVisibility' must be one of ${FREE_BUSY_VISIBILITIES.join(", ")}.`);
    }
}

/** The lowercased domain of `address` (everything after the last `@`). */
export function addressDomain(address: string): string {
    const normalized: string = normalizeAddress(address);
    return normalized.slice(normalized.lastIndexOf("@") + 1);
}

/** A validated `POST /calendar-events/free-busy` body: normalized, de-duplicated addresses in first-seen order. */
export interface FreeBusyRequest {
    addresses: string[];
    start: Date;
    end: Date;
}

/** What one address's answer says: `available` (with the busy windows), `unknown` (no information: not a local mailbox, or
 * too much on its calendar to compute) or `restricted` (a mailbox whose owner does not share it with the caller). */
export type FreeBusyStatus = "available" | "unknown" | "restricted";

/** One busy window, as ISO 8601 UTC strings. */
export interface FreeBusyWindow {
    start: string;
    end: string;
    tentative: boolean;
}

export interface FreeBusyResult {
    address: string;
    status: FreeBusyStatus;
    /** Empty unless `status` is `available`. */
    busy: FreeBusyWindow[];
}

export interface FreeBusyResponse {
    start: string;
    end: string;
    results: FreeBusyResult[];
}

const badRequest = (message: string): ApiError => new ApiError(ApiErrors.INVALID_REQUEST, 400, message);

/** A full ISO 8601 date-time (`2026-06-01T09:00:00Z`, with or without an offset or milliseconds) as a `Date`, or `undefined`. */
function parseDateTime(value: unknown): Date | undefined {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
        return undefined;
    }
    const date: Date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Validates a request body: `addresses` a list of 1 to `FREE_BUSY_MAX_ADDRESSES` plain addresses (`isPlainAddress()`),
 * `start` and `end` ISO 8601 date-times with `end` after `start` and at most `FREE_BUSY_MAX_WINDOW_MS` apart. The addresses
 * are trimmed, lowercased and de-duplicated.
 *
 * @throws {ApiError} 400 for anything else.
 */
export function parseFreeBusyRequest(body: unknown): FreeBusyRequest {
    const { addresses, start, end } = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > FREE_BUSY_MAX_ADDRESSES) {
        throw badRequest(`'addresses' must be a list of 1 to ${FREE_BUSY_MAX_ADDRESSES} addresses.`);
    }
    if (!addresses.every((address) => typeof address === "string" && isPlainAddress(address.trim()))) {
        throw badRequest("Every address must be one plain email address.");
    }
    const startDate: Date | undefined = parseDateTime(start);
    const endDate: Date | undefined = parseDateTime(end);
    if (!startDate || !endDate) {
        throw badRequest("'start' and 'end' must be ISO 8601 date-times.");
    }
    if (endDate.getTime() <= startDate.getTime()) {
        throw badRequest("'end' must be after 'start'.");
    }
    if (endDate.getTime() - startDate.getTime() > FREE_BUSY_MAX_WINDOW_MS) {
        throw badRequest("The window may be at most 31 days long.");
    }
    return { addresses: [...new Set((addresses as string[]).map((address) => normalizeAddress(address)))], start: startDate, end: endDate };
}

/** What `lookupFreeBusy()` needs, supplied by `BaseCalendarEventRoute` (which owns the repositories and ACL checks). */
export interface FreeBusyLookupContext {
    /** The signed-in caller. */
    caller: JWTUser;
    /** Whether the caller holds a trusted role - which only decides whether a mailbox they may not see reads `restricted` or
     * `unknown`, never what they may see. */
    isTrusted: boolean;
    mailboxRepo: RepoUtils<any>;
    folderRepo: RepoUtils<any>;
    eventRepo: RepoUtils<any>;
    /** The backend's query value matching one element of `Mailbox.aliasAddresses`. */
    aliasQueryValue: (address: string) => any;
    /** Whether the caller holds `action` on the mailbox or folder `uid` by ownership or an ACL record - never by a trusted role
     * (`hasMailAccess()`). */
    hasAccess: (uid: string, action: string) => Promise<boolean>;
}

/** Runs `task` over `items`, `size` at a time, keeping the order of the results. */
async function mapInChunks<T, R>(items: T[], size: number, task: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = [];
    for (let i = 0; i < items.length; i += size) {
        results.push(...(await Promise.all(items.slice(i, i + size).map(task))));
    }
    return results;
}

/**
 * The free/busy of each of `request.addresses` for the caller - see the file comment for what may be learned. One entry per
 * address, in order. A mailbox is checked against its owner's `freeBusyVisibility`:
 *
 * - the caller's own mailboxes (owner, or full access) are always visible;
 * - `everyone`: visible;
 * - `domain`: visible when the caller owns a mailbox whose primary address is in the same domain, or - since they can read its
 * events anyway - holds read, list or freebusy access on the mailbox or one of its calendar folders;
 * - `shared`: visible only with that access;
 * - `nobody`: only the owner and full-access delegates.
 */
export async function lookupFreeBusy(ctx: FreeBusyLookupContext, request: FreeBusyRequest): Promise<FreeBusyResponse> {
    const ownerUids: string[] = [...new Set([ctx.caller.uid, ctx.caller.uid.toLowerCase()])];
    const owned: Mailbox[] = await ctx.mailboxRepo.find({ ownerUserUid: ModelUtils.literal(ownerUids, "in"), limit: 100 } as any, {
        ignoreACL: true,
        limit: 100,
    });
    const ownedUids: Set<string> = new Set(owned.map((mailbox) => mailbox.uid));
    const ownedDomains: Set<string> = new Set(owned.map((mailbox) => addressDomain(mailbox.primarySmtpAddress)));
    // Somebody the directory would answer, so that "restricted" tells them nothing they cannot already learn.
    const canResolve: boolean = owned.length > 0 || ctx.isTrusted;
    const finder = { mailboxRepo: ctx.mailboxRepo, aliasQueryValue: ctx.aliasQueryValue, authServerUrl: "", staticAliases: [], authTimeoutMs: 0 };

    const results: FreeBusyResult[] = await mapInChunks(request.addresses, LOOKUP_CONCURRENCY, async (address): Promise<FreeBusyResult> => {
        const mailbox: Mailbox | undefined = await findMailboxByAddress(finder, address);
        if (!mailbox) {
            return { address, status: "unknown", busy: [] };
        }
        const folders: string[] = await calendarFolderUids(ctx, mailbox.uid);
        if (!(await mayView(ctx, mailbox, folders, ownedUids, ownedDomains))) {
            return { address, status: canResolve ? "restricted" : "unknown", busy: [] };
        }
        const busy: BusyInterval[] | undefined = await readBusy(ctx, mailbox, new Set(folders), request.start, request.end);
        return busy
            ? {
                  address,
                  status: "available",
                  busy: busy.map((window) => ({ start: window.start.toISOString(), end: window.end.toISOString(), tentative: window.tentative })),
              }
            : { address, status: "unknown", busy: [] };
    });
    return { start: request.start.toISOString(), end: request.end.toISOString(), results };
}

/** The uids of `mailboxUid`'s calendar folders that are not deleted. */
async function calendarFolderUids(ctx: FreeBusyLookupContext, mailboxUid: string): Promise<string[]> {
    const folders: { uid: string; deleted?: boolean }[] = await ctx.folderRepo.find(
        { mailboxUid: ModelUtils.literal(mailboxUid), type: ModelUtils.literal(FolderType.CALENDAR), limit: FREE_BUSY_MAX_FOLDERS } as any,
        { ignoreACL: true, limit: FREE_BUSY_MAX_FOLDERS },
    );
    return folders.filter((folder) => folder.deleted !== true).map((folder) => folder.uid);
}

/** Whether the caller may see `mailbox`'s free/busy - see `lookupFreeBusy()`. */
async function mayView(
    ctx: FreeBusyLookupContext,
    mailbox: Mailbox,
    folders: string[],
    ownedUids: ReadonlySet<string>,
    ownedDomains: ReadonlySet<string>,
): Promise<boolean> {
    const visibility: FreeBusyVisibility = effectiveFreeBusyVisibility(mailbox);
    if (ownedUids.has(mailbox.uid) || visibility === "everyone") {
        return true;
    }
    if (visibility === "nobody") {
        return await ctx.hasAccess(mailbox.uid, ACLAction.FULL);
    }
    if (visibility === "domain" && ownedDomains.has(addressDomain(mailbox.primarySmtpAddress))) {
        return true;
    }
    for (const uid of [mailbox.uid, ...folders]) {
        for (const action of SHARED_ACTIONS) {
            if (await ctx.hasAccess(uid, action)) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Reads one page after another of the mailbox's `CalendarEvent` rows matching `criteria`, in a stable order - or `undefined`
 * once `FREE_BUSY_LIMITS.maxPages` full pages have been read without reaching the end (the same bounded read as
 * `ScanQueueJob.readBookingPages()`).
 */
async function readPages(ctx: FreeBusyLookupContext, criteria: Record<string, any>): Promise<CalendarEvent[] | undefined> {
    const all: CalendarEvent[] = [];
    for (let page = 0; page < FREE_BUSY_LIMITS.maxPages; page++) {
        const rows: CalendarEvent[] = await ctx.eventRepo.find(
            { ...criteria, sort: { startDate: "ASC", uid: "ASC" }, limit: FREE_BUSY_LIMITS.pageSize, page } as any,
            { ignoreACL: true, limit: FREE_BUSY_LIMITS.pageSize, page, skipCache: true },
        );
        all.push(...rows);
        if (rows.length < FREE_BUSY_LIMITS.pageSize) {
            return all;
        }
    }
    return undefined;
}

/**
 * The merged busy windows of `mailbox` over `[start, end]`, or `undefined` when its calendar is too large to read within the
 * bounds (`FREE_BUSY_LIMITS.maxPages` pages of `FREE_BUSY_LIMITS.pageSize` rows for each of three queries) or leaves more than
 * `FREE_BUSY_LIMITS.maxWindows` windows - "we did not look" must never read as "free". The three queries are the events overlapping the
 * window, the recurring masters (whose later occurrences reach the window however long ago they started - ended series are
 * dropped) and the moved occurrences, whose `recurrenceId`s exclude their master's phantom occurrence.
 *
 * Only rows in the mailbox's own calendar folders count. The reads leave soft-deleted rows out (`RepoUtils.find()`'s default), so a
 * deleted event is not busy - and a deleted moved occurrence no longer stands for its master's, whose original occurrence then
 * counts again (a cancelled one, which stays a row, does stand for it).
 */
async function readBusy(
    ctx: FreeBusyLookupContext,
    mailbox: Mailbox,
    folders: ReadonlySet<string>,
    start: Date,
    end: Date,
): Promise<BusyInterval[] | undefined> {
    const mailboxUid = ModelUtils.literal(mailbox.uid);
    const overlapping: CalendarEvent[] | undefined = await readPages(ctx, {
        mailboxUid,
        startDate: `lt(${end.toISOString()})`,
        endDate: `gt(${start.toISOString()})`,
    });
    const masters: CalendarEvent[] | undefined = overlapping && (await readPages(ctx, { mailboxUid, recurrenceRule: "ne(null)" }));
    const moved: CalendarEvent[] | undefined =
        masters && (await readPages(ctx, { mailboxUid, recurrenceId: `gte(${new Date(start.getTime() - OVERRIDE_LOOKBACK_MS).toISOString()})` }));
    if (!overlapping || !masters || !moved) {
        return undefined;
    }

    const rows: Map<string, CalendarEvent> = new Map();
    for (const row of [...overlapping, ...moved]) {
        rows.set(row.uid, row);
    }
    for (const row of masters) {
        const until: Date | undefined = row.recurrenceRule?.until ? new Date(row.recurrenceRule.until) : undefined;
        if (!row.recurrenceId && (!until || Number.isNaN(until.getTime()) || until.getTime() >= start.getTime())) {
            rows.set(row.uid, row);
        }
    }
    const events: CalendarEvent[] = [...rows.values()].filter((row) => folders.has(row.folderUid));

    const merged: BusyInterval[] = mergeBusyIntervals(computeBusyIntervals(events, start, end, mailboxAddressSet(mailbox)), start, end);
    return merged.length > FREE_BUSY_LIMITS.maxWindows ? undefined : merged;
}
