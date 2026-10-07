///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The consuming application must apply `@ApiRoute("mail/directory")` to its own concrete subclass - `@Get()` and
// `@Get("/contacts")` below then resolve to `GET /mail/directory` and `GET /mail/directory/contacts`.
import { ApiError, ObjectDecorators, UserUtils, type JWTUser } from "@rapidrest/core";
import { ACLAction, ACLUtils, ApiErrorMessages, ApiErrors, ModelUtils, ObjectFactory, RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { Contact, Correspondent, DataSubjectErasureRequest, DistributionList, Folder, FolderType, Mailbox } from "../models/types.js";
import { CorrespondentBackfillUtils, CorrespondentUtils } from "../util/CorrespondentUtils.js";
import { assertMailAccess, hasMailAccess } from "../util/MailAccessUtils.js";
import { SuggestedContactUtils, type SuggestedContactsResult } from "../util/SuggestedContactUtils.js";
const { Config, Init, Inject } = ObjectDecorators;
const { Auth, Get, Post, Query, RateLimit, User: AuthUser } = RouteDecorators;

/** What a directory entry names: a person's mailbox, a shared mailbox, a room or equipment resource, a distribution
 * list, (from `GET /contacts`) one of the caller's own contacts, or (from `GET /correspondents`) somebody the caller's
 * mailboxes have exchanged mail or calendar invitations with. */
export type DirectoryEntryKind = "user" | "shared" | "room" | "equipment" | "list" | "contact" | "correspondent";

/** One recipient suggestion. Deliberately nothing else - no uid, owner, policy, key or membership. */
export interface DirectoryEntry {
    displayName: string;
    address: string;
    kind: DirectoryEntryKind;
}

/** The shortest query (after trimming) either endpoint searches for. */
export const DIRECTORY_MIN_QUERY_LENGTH = 2;
/** The longest query either endpoint accepts. */
export const DIRECTORY_MAX_QUERY_LENGTH = 100;
/** Words past this many in a query are ignored. */
export const DIRECTORY_MAX_TERMS = 5;
export const DIRECTORY_DEFAULT_LIMIT = 8;
export const DIRECTORY_MAX_LIMIT = 20;
/**
 * Requests one signed-in caller may make to each endpoint per `DIRECTORY_WINDOW_SECONDS`.
 *
 * Sized for a person using the product, not for the theoretical minimum a debounced typeahead needs: a recipient
 * field asks both of these endpoints on every pause in typing, so one addressed message costs a burst of them, and a
 * compose window with several recipients - or a user who keeps typing while the suggestions are open - reached the
 * old 120 a minute in about twenty seconds of ordinary composing. The limit then answered every further request
 * with a 429 for the rest of the minute, which a client can only show as suggestions that silently stopped working.
 *
 * Note this number is what a *signed-in* caller gets: a deployment's `rateLimit.authenticated` tier (the server's
 * own config) does not raise a limit a `@RateLimit()` decorator states explicitly - an explicit per-endpoint limit
 * is applied on top of it - so this constant, not that tier, is the ceiling interactive use runs into. 600 a minute
 * is 10 a second sustained per caller per endpoint: far above anything a person can drive a text field at, and
 * still a hard bound on using the directory as a bulk enumeration source.
 */
export const DIRECTORY_MAX_ATTEMPTS = 600;
export const DIRECTORY_WINDOW_SECONDS = 60;
/** How many contact folders `GET /contacts` searches at most. */
export const DIRECTORY_MAX_CONTACT_FOLDERS = 50;

/** Erasure states after which a mailbox is on its way out, and no longer suggested. */
const ERASING_STATUSES: DataSubjectErasureRequest["status"][] = ["approved", "in_progress"];

/** A validated query: its lowercased words and the whole lowercased query. */
export interface DirectoryQuery {
    terms: string[];
    text: string;
    limit: number;
}

/**
 * Validates `q` and `limit`. `q` must be one string of `DIRECTORY_MIN_QUERY_LENGTH`..`DIRECTORY_MAX_QUERY_LENGTH`
 * characters once trimmed; it is split on whitespace into at most `DIRECTORY_MAX_TERMS` distinct lowercased words.
 * `limit` defaults to `DIRECTORY_DEFAULT_LIMIT` and is capped at `DIRECTORY_MAX_LIMIT`.
 *
 * @throws {ApiError} 400 for a missing, repeated, too short or too long `q`, or a `limit` that isn't a positive integer.
 */
export function parseDirectoryQuery(q: unknown, limit: unknown): DirectoryQuery {
    if (typeof q !== "string") {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The 'q' query parameter is required.");
    }
    const text: string = q.trim().toLowerCase();
    if (text.length < DIRECTORY_MIN_QUERY_LENGTH || text.length > DIRECTORY_MAX_QUERY_LENGTH) {
        throw new ApiError(
            ApiErrors.INVALID_REQUEST,
            400,
            `The 'q' query parameter must be ${DIRECTORY_MIN_QUERY_LENGTH} to ${DIRECTORY_MAX_QUERY_LENGTH} characters long.`,
        );
    }
    let parsedLimit: number = DIRECTORY_DEFAULT_LIMIT;
    if (limit !== undefined && limit !== "") {
        parsedLimit = typeof limit === "string" && /^\d{1,6}$/.test(limit) ? Number(limit) : typeof limit === "number" ? limit : NaN;
        if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The 'limit' query parameter must be a positive integer.");
        }
    }
    const terms: string[] = [...new Set(text.split(/\s+/))].slice(0, DIRECTORY_MAX_TERMS);
    return { terms, text, limit: Math.min(parsedLimit, DIRECTORY_MAX_LIMIT) };
}

/** The words of a name that a term may be a prefix of: split on spaces and hyphens, lowercased. */
export function directoryNameWords(...names: (string | undefined)[]): string[] {
    return names.flatMap((name) => (name ?? "").toLowerCase().split(/[\s-]+/)).filter((word) => word.length > 0);
}

/** Whether every term is a prefix of one of `words` or of `address` (case-insensitively). */
export function matchesDirectoryTerms(terms: string[], words: string[], address: string): boolean {
    const lowerAddress: string = address.toLowerCase();
    return terms.every((term) => lowerAddress.startsWith(term) || words.some((word) => word.startsWith(term)));
}

/** Escapes `value` for a regular expression, so it only ever matches itself. */
export function escapeDirectoryRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Escapes `value` for a SQL `LIKE ... ESCAPE '!'` pattern (`routes/sql/LikeUtils.ts`: a backslash escape isn't valid on MySQL), so `%` and `_` only ever match themselves. */
export function escapeDirectoryLike(value: string): string {
    return value.replace(/[!%_]/g, (ch) => `!${ch}`);
}

/** Sorts entries whose name or address starts with the whole query first, then by name and address; drops repeated
 * addresses (case-insensitively, keeping the first) and keeps `limit`. */
export function rankDirectoryEntries(entries: DirectoryEntry[], text: string, limit: number): DirectoryEntry[] {
    const rank = (entry: DirectoryEntry): number =>
        entry.displayName.toLowerCase().startsWith(text) || entry.address.toLowerCase().startsWith(text) ? 0 : 1;
    const sorted: DirectoryEntry[] = [...entries].sort(
        (a, b) =>
            rank(a) - rank(b) ||
            a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }) ||
            a.address.localeCompare(b.address),
    );
    const seen = new Set<string>();
    const result: DirectoryEntry[] = [];
    for (const entry of sorted) {
        const key: string = entry.address.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            result.push(entry);
        }
        if (result.length === limit) {
            break;
        }
    }
    return result;
}

function mailboxKind(mailbox: Mailbox): DirectoryEntryKind {
    if (mailbox.isResource) {
        return mailbox.resourceType === "equipment" ? "equipment" : "room";
    }
    return mailbox.ownerUserUid ? "user" : "shared";
}

/**
 * Recipient suggestions for compose: `GET /` searches this server's address directory (mailboxes and distribution
 * lists), `GET /contacts` the caller's own contacts and `GET /correspondents` the people the caller's mailboxes have
 * corresponded with (`Correspondent`). All match each word of `q` against the start of a name word
 * (split on spaces and hyphens) or the start of an address (so its local part), case-insensitively, and return only
 * `DirectoryEntry` fields.
 *
 * All require a signed-in caller and are rate limited per caller (`DIRECTORY_MAX_ATTEMPTS` a minute each). `q` is
 * always matched literally: the concrete subclasses escape it for a regular expression (Mongo) or a `LIKE` pattern
 * (SQL) and never pass it through the search query parser, so it can't carry operators, and a regular expression built
 * from escaped text can't backtrack catastrophically. Results are re-checked in code with `matchesDirectoryTerms()`, so both
 * backends return the same entries.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseDirectoryRoute<M extends Mailbox, F extends Folder> {
    protected abstract mailboxClass: any;
    protected abstract folderClass: any;
    protected abstract erasureRequestClass: any;
    /** The `Message`, `CalendarEvent` and `Correspondent` model classes: `GET /correspondents` reads the first two, once per
     * mailbox, to build the third (`CorrespondentBackfillUtils.ensureCorrespondentsBackfilled()`). */
    protected abstract messageClass: any;
    protected abstract calendarEventClass: any;
    protected abstract correspondentClass: any;
    /** The `Contact` model class: `POST /suggested-contacts` writes the people a mailbox has corresponded with into its Suggested Contacts folder. */
    protected abstract contactClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;
    private mailboxRepo?: RepoUtils<M>;
    private folderRepo?: RepoUtils<F>;
    private erasureRepo?: RepoUtils<DataSubjectErasureRequest>;
    protected messageRepo?: RepoUtils<any>;
    protected calendarEventRepo?: RepoUtils<any>;
    protected correspondentRepo?: RepoUtils<any>;
    protected contactRepo?: RepoUtils<any>;

    /** Records the correspondents, built once by `initialize()` from the repositories above. */
    protected correspondentUtils?: CorrespondentUtils;

    /** Backfills a mailbox's correspondents from its existing mail and events, built once by `initialize()` on `correspondentUtils`. */
    protected correspondentBackfillUtils?: CorrespondentBackfillUtils;

    /** Turns a mailbox's correspondents into contacts of its Suggested Contacts folder, built once by `initialize()`. */
    protected suggestedContactUtils?: SuggestedContactUtils;

    @Inject(ACLUtils)
    private aclUtils?: ACLUtils;

    @Config("trusted_roles", ["admin"])
    private trustedRoles: string[] = ["admin"];

    /** Mailboxes matching every term by `displayName` or `primarySmtpAddress`, sorted by display name, at most `limit`.
     * Only `displayName`, `primarySmtpAddress`, `ownerUserUid`, `isResource`, `resourceType` and `uid` are read. */
    protected abstract findMailboxCandidates(terms: string[], limit: number): Promise<M[]>;

    /** Distribution lists that aren't soft-deleted matching every term by `name` or `primarySmtpAddress`, at most `limit`. */
    protected abstract findDistributionListCandidates(terms: string[], limit: number): Promise<DistributionList[]>;

    /** Contacts that aren't soft-deleted in `folderUids` matching every term by `displayName`, `givenName`, `surname`
     * or one of `emails`' addresses, at most `limit`. */
    protected abstract findContactCandidates(folderUids: string[], terms: string[], limit: number): Promise<Contact[]>;

    /** Correspondents in `mailboxUids` matching every term by `displayName` or `address`, most recently seen first and then
     * most often seen, at most `limit`. Only `address`, `displayName`, `lastSeenAt` and `count` are read. */
    protected abstract findCorrespondentCandidates(mailboxUids: string[], terms: string[], limit: number): Promise<Correspondent[]>;

    @Init
    protected async initialize(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        if (!this.mailboxRepo && this.mailboxClass) {
            this.mailboxRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.mailboxClass.name, args: [this.mailboxClass] });
        }
        if (!this.folderRepo && this.folderClass) {
            this.folderRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.folderClass.name, args: [this.folderClass] });
        }
        if (!this.erasureRepo && this.erasureRequestClass) {
            this.erasureRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.erasureRequestClass.name, args: [this.erasureRequestClass] });
        }
        if (!this.messageRepo && this.messageClass) {
            this.messageRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.messageClass.name, args: [this.messageClass] });
        }
        if (!this.calendarEventRepo && this.calendarEventClass) {
            this.calendarEventRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.calendarEventClass.name, args: [this.calendarEventClass] });
        }
        if (!this.correspondentRepo && this.correspondentClass) {
            this.correspondentRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.correspondentClass.name, args: [this.correspondentClass] });
        }
        if (!this.contactRepo && this.contactClass) {
            this.contactRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.contactClass.name, args: [this.contactClass] });
        }
        if (!this.suggestedContactUtils && this.correspondentRepo && this.folderRepo && this.contactRepo) {
            this.suggestedContactUtils = await this._objectFactory.newInstance(SuggestedContactUtils, {
                name: this.correspondentClass.name,
                args: [this.correspondentRepo, this.folderRepo, this.contactRepo, this.folderClass, this.contactClass],
            });
        }
        if (!this.correspondentUtils && this.correspondentRepo && this.mailboxRepo) {
            this.correspondentUtils = await this._objectFactory.newInstance(CorrespondentUtils, {
                name: this.correspondentClass.name,
                args: [this.correspondentRepo, this.mailboxRepo],
            });
        }
        if (!this.correspondentBackfillUtils && this.correspondentUtils && this.folderRepo && this.messageRepo && this.calendarEventRepo) {
            this.correspondentBackfillUtils = await this._objectFactory.newInstance(CorrespondentBackfillUtils, {
                name: this.correspondentClass.name,
                args: [this.correspondentUtils, this.folderRepo, this.messageRepo, this.calendarEventRepo],
            });
        }
    }

    /** The mailboxes `user` owns (their uid exactly or lowercased). */
    private async ownedMailboxes(user: JWTUser): Promise<M[]> {
        const uids: string[] = [...new Set([user.uid, user.uid.toLowerCase()])];
        return await this.mailboxRepo!.find({ ownerUserUid: ModelUtils.literal(uids, "in") } as any, { ignoreACL: true, limit: 10 });
    }

    /** `candidates` without mailboxes an approved or running erasure is about to remove. */
    private async withoutErasing(candidates: M[]): Promise<M[]> {
        if (candidates.length === 0) {
            return candidates;
        }
        const requests: DataSubjectErasureRequest[] = await this.erasureRepo!.find(
            {
                mailboxUid: ModelUtils.literal(
                    candidates.map((mailbox) => mailbox.uid),
                    "in",
                ),
                status: ModelUtils.literal(ERASING_STATUSES, "in"),
            } as any,
            { ignoreACL: true, limit: candidates.length * ERASING_STATUSES.length },
        );
        const erasing = new Set<string>(requests.map((request) => request.mailboxUid));
        return candidates.filter((mailbox) => !erasing.has(mailbox.uid));
    }

    /**
     * Searches this server's address directory: user, shared and resource mailboxes and distribution lists, deduplicated
     * by address. Mailboxes with an approved or running erasure and soft-deleted lists are left out; aliases aren't
     * matched or returned. The platform has no "hidden from address lists" setting, so every other mailbox and list
     * is listed.
     *
     * Only callers who own a mailbox on this server (or hold a trusted role) may search, so an identity from the shared
     * auth service with no mailbox here can't read the directory: 403 otherwise.
     */
    @Auth(["jwt"])
    @RateLimit({ perUser: true, maxAttempts: DIRECTORY_MAX_ATTEMPTS, windowSeconds: DIRECTORY_WINDOW_SECONDS })
    @Get()
    public async search(@Query("q") q: unknown, @Query("limit") limit: unknown, @AuthUser user?: JWTUser): Promise<DirectoryEntry[]> {
        const query: DirectoryQuery = parseDirectoryQuery(q, limit);
        if (!UserUtils.hasRoles(user, this.trustedRoles) && (await this.ownedMailboxes(user!)).length === 0) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, "Only users with a mailbox on this server can search its directory.");
        }
        // A few extra candidates, so the erasure filter and address de-duplication rarely leave fewer than `limit`.
        const fetch: number = query.limit * 2;
        const [mailboxes, lists] = await Promise.all([
            this.findMailboxCandidates(query.terms, fetch).then((found) => this.withoutErasing(found)),
            this.findDistributionListCandidates(query.terms, fetch),
        ]);
        const entries: DirectoryEntry[] = [
            ...mailboxes
                .filter((mailbox) => matchesDirectoryTerms(query.terms, directoryNameWords(mailbox.displayName), mailbox.primarySmtpAddress))
                .map((mailbox) => ({ displayName: mailbox.displayName, address: mailbox.primarySmtpAddress, kind: mailboxKind(mailbox) })),
            ...lists
                .filter((list) => matchesDirectoryTerms(query.terms, directoryNameWords(list.name), list.primarySmtpAddress))
                .map((list) => ({ displayName: list.name, address: list.primarySmtpAddress, kind: "list" as const })),
        ];
        return rankDirectoryEntries(entries, query.text, query.limit);
    }

    /**
     * Searches the caller's own contacts: every contacts folder (not soft-deleted) of the mailboxes the caller owns, plus
     * those of `mailboxUid` (the mailbox being composed from) when the caller may read it, keeping only folders the
     * caller may read. One entry per matching address - every address of a contact whose name matches, or just the
     * addresses that match. A caller with no such folders gets `[]`, and an unreadable `mailboxUid` is ignored.
     */
    @Auth(["jwt"])
    @RateLimit({ perUser: true, maxAttempts: DIRECTORY_MAX_ATTEMPTS, windowSeconds: DIRECTORY_WINDOW_SECONDS })
    @Get("/contacts")
    public async searchContacts(
        @Query("q") q: unknown,
        @Query("limit") limit: unknown,
        @Query("mailboxUid") mailboxUid: unknown,
        @AuthUser user?: JWTUser,
    ): Promise<DirectoryEntry[]> {
        const query: DirectoryQuery = parseDirectoryQuery(q, limit);
        const mailboxUids = new Set<string>((await this.ownedMailboxes(user!)).map((mailbox) => mailbox.uid));
        if (typeof mailboxUid === "string" && mailboxUid && !mailboxUids.has(mailboxUid)) {
            if (await hasMailAccess(this.aclUtils, this.trustedRoles, user, mailboxUid, ACLAction.READ)) {
                mailboxUids.add(mailboxUid);
            }
        }
        if (mailboxUids.size === 0) {
            return [];
        }
        const folders: F[] = await this.folderRepo!.find(
            { mailboxUid: ModelUtils.literal([...mailboxUids], "in"), type: ModelUtils.literal(FolderType.CONTACTS) } as any,
            { ignoreACL: true, limit: DIRECTORY_MAX_CONTACT_FOLDERS },
        );
        const readable: string[] = [];
        for (const folder of folders) {
            if (folder.deleted !== true && (await hasMailAccess(this.aclUtils, this.trustedRoles, user, folder.uid, ACLAction.READ))) {
                readable.push(folder.uid);
            }
        }
        if (readable.length === 0) {
            return [];
        }
        const contacts: Contact[] = await this.findContactCandidates(readable, query.terms, query.limit * 2);
        const entries: DirectoryEntry[] = [];
        for (const contact of contacts) {
            const words: string[] = directoryNameWords(contact.displayName, contact.givenName, contact.surname);
            const name: string = contact.displayName || [contact.givenName, contact.surname].filter(Boolean).join(" ");
            for (const email of contact.emails) {
                if (typeof email?.address === "string" && email.address && matchesDirectoryTerms(query.terms, words, email.address)) {
                    entries.push({ displayName: name, address: email.address, kind: "contact" });
                }
            }
        }
        return rankDirectoryEntries(entries, query.text, query.limit);
    }

    /**
     * Searches the people the caller's mailboxes have corresponded with: everyone who sent or received mail with, or shared a
     * calendar event with, the mailboxes the caller owns plus `mailboxUid` (the mailbox being composed from) when the caller
     * may read it - an unreadable `mailboxUid` is ignored, and a caller with no mailbox gets `[]`. Entries have kind
     * `correspondent`, one per address across those mailboxes, most recently seen first and then most often seen.
     *
     * The first time a mailbox is searched its correspondents are built from the mail and events it already holds
     * (`CorrespondentBackfillUtils.ensureCorrespondentsBackfilled()`, bounded), so the first search of an old mailbox is slower than the rest.
     */
    @Auth(["jwt"])
    @RateLimit({ perUser: true, maxAttempts: DIRECTORY_MAX_ATTEMPTS, windowSeconds: DIRECTORY_WINDOW_SECONDS })
    @Get("/correspondents")
    public async searchCorrespondents(
        @Query("q") q: unknown,
        @Query("limit") limit: unknown,
        @Query("mailboxUid") mailboxUid: unknown,
        @AuthUser user?: JWTUser,
    ): Promise<DirectoryEntry[]> {
        const query: DirectoryQuery = parseDirectoryQuery(q, limit);
        const mailboxes = new Map<string, M>((await this.ownedMailboxes(user!)).map((mailbox) => [mailbox.uid, mailbox]));
        if (typeof mailboxUid === "string" && mailboxUid && !mailboxes.has(mailboxUid)) {
            if (await hasMailAccess(this.aclUtils, this.trustedRoles, user, mailboxUid, ACLAction.READ)) {
                const extra: M | undefined = await this.mailboxRepo!.findOne(mailboxUid, { ignoreACL: true });
                if (extra) {
                    mailboxes.set(extra.uid, extra);
                }
            }
        }
        if (mailboxes.size === 0) {
            return [];
        }
        for (const mailbox of mailboxes.values()) {
            await this.correspondentBackfillUtils!.ensureCorrespondentsBackfilled(mailbox);
        }
        const rows: Correspondent[] = await this.findCorrespondentCandidates([...mailboxes.keys()], query.terms, query.limit * 2);
        // The same person in several mailboxes is one suggestion: the candidates are ordered per query, so re-order across
        // mailboxes (most recently seen, then most often) before the first of each address is kept.
        const time = (row: Correspondent): number => new Date(row.lastSeenAt).getTime() || 0;
        const ordered: Correspondent[] = rows
            .filter((row) => matchesDirectoryTerms(query.terms, directoryNameWords(row.displayName), row.address))
            .sort((a, b) => time(b) - time(a) || b.count - a.count);
        const seen = new Set<string>();
        const entries: DirectoryEntry[] = [];
        for (const row of ordered) {
            if (!seen.has(row.address)) {
                seen.add(row.address);
                entries.push({ displayName: row.displayName, address: row.address, kind: "correspondent" });
            }
        }
        return entries.slice(0, query.limit);
    }
    /**
     * Fills the Suggested Contacts folder of `mailboxUid` - a contacts folder of its own (`FolderType.SUGGESTED_CONTACTS`), kept
     * apart from the user's normal contacts - with a contact per person the mailbox has exchanged mail or calendar invitations
     * with. The folder is created the first time. A mailbox's existing history is included (its correspondents are backfilled
     * first, `CorrespondentBackfillUtils.ensureCorrespondentsBackfilled()`). Addresses that already are a contact of the mailbox
     * (in any of its contacts folders) are skipped, and every address is considered once ever, so a suggested contact the user
     * deleted or moved never comes back (`SuggestedContactUtils`).
     *
     * Needs the right to create in the mailbox (its owner, or a delegate with write access - 403 otherwise, also for an unknown
     * mailbox; 400 without `mailboxUid`; 404 if the mailbox has gone). At most `SUGGESTED_CONTACTS_MAX_PER_CALL` contacts are
     * created per call: while `remaining` is above `0`, call again.
     *
     * Responds `{ folderUid, created, remaining }`.
     */
    @Auth(["jwt"])
    @RateLimit({ perUser: true, maxAttempts: DIRECTORY_MAX_ATTEMPTS, windowSeconds: DIRECTORY_WINDOW_SECONDS })
    @Post("/suggested-contacts")
    public async createSuggestedContacts(@Query("mailboxUid") mailboxUid: unknown, @AuthUser user?: JWTUser): Promise<SuggestedContactsResult> {
        if (typeof mailboxUid !== "string" || !mailboxUid) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The 'mailboxUid' query parameter is required.");
        }
        await assertMailAccess(this.aclUtils, this.trustedRoles, user, mailboxUid, ACLAction.CREATE);
        const mailbox: M | undefined = await this.mailboxRepo!.findOne(mailboxUid, { ignoreACL: true });
        if (!mailbox) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        await this.correspondentBackfillUtils!.ensureCorrespondentsBackfilled(mailbox);
        return await this.suggestedContactUtils!.ensureSuggestedContacts(mailbox.uid, user);
    }
}
