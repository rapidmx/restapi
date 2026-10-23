///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { createHash, randomUUID } from "node:crypto";
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import {
    ApiErrorMessages,
    ApiErrors,
    DocDecorators,
    type HttpRequest,
    type HttpResponse,
    ObjectFactory,
    RepoUtils,
    RouteDecorators,
} from "@rapidrest/service-core";
import type { BlobStore } from "../blob/BlobStore.js";
import type {
    IndexSegment,
    Mailbox,
    SealedIndexEntry,
    SegmentManifest,
    ZeroAccessIndexEntry,
    ZeroAccessIndexSegment,
    ZeroAccessKey,
    ZeroAccessSegmentOrigin,
} from "../models/types.js";
import { findPagesByUid } from "../util/MailboxContentUtils.js";
import { isoWeekStart, pendingEntriesByWeek, zeroAccessSegmentBlobKey, zeroAccessSegmentUid } from "../zeroaccess/ZeroAccessIndexStore.js";
import { isSealedToCertificate } from "../zeroaccess/ZeroAccessSealer.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;
const { Description, Returns, Summary } = DocDecorators;
const { Get, Param, Put, Query, Request, Response, User: AuthUser } = RouteDecorators;

/** The most entries one `GET .../entries` page holds. */
const MAX_ENTRY_PAGE = 500;

/** The most entry uids one compaction may fold. */
const MAX_FOLDED_ENTRIES = 100_000;

/** The segment format the current clients write (`specs/search.md` §16); newer ones are accepted for newer clients. */
const MIN_SCHEMA_VERSION = 1;

/** `PUT /mail/mailboxes/:id/search-index/segments/:weekId`. */
export interface SegmentUpload {
    /** The generation the client compacted on top of: `0` for a week with no segment yet. A different current generation is a `409`. */
    expectedGeneration: number;
    /** The sealed SQLite FTS5 file, base64: CMS `EnvelopedData` to one of the mailbox's zero-access keys. */
    segment: string;
    /** Fingerprint of the zero-access key `segment` is encrypted to. */
    keyFingerprint: string;
    schemaVersion: number;
    /** `zero-access` (the default): compacted from the server's entries. `client`: built from end-to-end encrypted mail (Source C). */
    origin?: ZeroAccessSegmentOrigin;
    /** The pending entries this generation folds in, removed once it is stored. Empty for a `client` segment. */
    foldedEntryUids?: string[];
}

/** `GET .../entries`'s answer. */
export interface SealedIndexEntryPage {
    entries: SealedIndexEntry[];
    /** Pass as `after` for the next page; absent on the last one. */
    next?: string;
}

/**
 * The search index of a zero-access mailbox (`specs/search.md` §7-8): the sealed index entries the server writes at delivery and the
 * weekly segments clients compact them into, all encrypted to the mailbox's zero-access key - this route only stores and serves
 * ciphertext.
 *
 * `GET /:id/search-index/manifest` lists every segment and, per week, how many entries are still pending and whether the week may be
 * compacted. It is cheap: entries are counted with one grouped query.
 *
 * `GET /:id/search-index/entries?week=&since=&after=&limit=` pages, by uid, through the pending entries, optionally of one week and
 * written at or after `since` - the live tail: a client asks from shortly before its last poll and drops the ones it has.
 *
 * `GET /:id/search-index/segments/:weekId?generation=&origin=` serves the current generation's file with its ETag (`404` once replaced).
 *
 * `PUT /:id/search-index/segments/:weekId` stores a compaction (`SegmentUpload`): a compare-and-swap on the generation, storing the new
 * file and removing the entries it folded and the previous generation's file. Entries that arrived during the compaction are not in the
 * list and stay pending for the next one, so a race never loses an entry. The file must be encrypted to one of the mailbox's
 * zero-access keys (`isSealedToCertificate()`): the server refuses to store what could be a readable index.
 *
 * Only the mailbox's owner may use any of it, as with the key vault: a delegate or an administrator gets a `403` (shared mailboxes,
 * whose members get the key through member wraps, come with `specs/search.md` §3 *Shared Mailboxes*).
 */
export abstract class BaseZeroAccessIndexRoute<M extends Mailbox> {
    protected abstract mailboxClass: any;
    protected abstract entryClass: any;
    protected abstract segmentClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    protected mailboxRepo?: RepoUtils<M>;
    protected entryRepo?: RepoUtils<ZeroAccessIndexEntry>;
    protected segmentRepo?: RepoUtils<ZeroAccessIndexSegment>;

    @Logger
    protected logger?: any;

    @Inject("BlobStore")
    protected blobStore?: BlobStore;

    /** How long after a week ends before it may be compacted, to absorb delayed delivery (`specs/search.md` §7). */
    @Config("mail:zero_access:compaction_grace_hours", 24)
    protected compactionGraceHours: number = 24;

    /** The largest segment file accepted, in bytes. */
    @Config("mail:zero_access:max_segment_bytes", 64 * 1024 * 1024)
    protected maxSegmentBytes: number = 64 * 1024 * 1024;

    @Init
    protected async initialize(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        this.mailboxRepo ??= await this._objectFactory.newInstance(RepoUtils, { name: this.mailboxClass.name, args: [this.mailboxClass] });
        this.entryRepo ??= await this._objectFactory.newInstance(RepoUtils, { name: this.entryClass.name, args: [this.entryClass] });
        this.segmentRepo ??= await this._objectFactory.newInstance(RepoUtils, { name: this.segmentClass.name, args: [this.segmentClass] });
    }

    /** The mailbox `mailboxId` names, when `user` owns it - else `403`, a missing mailbox included, so the answer reveals nothing. */
    private async requireOwnedMailbox(mailboxId: string, user: JWTUser | undefined): Promise<M> {
        const mailbox: M | undefined = await this.mailboxRepo!.findOne(mailboxId, { ignoreACL: true });
        if (!mailbox || !user || !mailbox.ownerUserUid || mailbox.ownerUserUid !== user.uid) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
        return mailbox;
    }

    private static requireWeekId(weekId: string): void {
        if (!isoWeekStart(weekId)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "weekId must be an ISO week, e.g. 2026-W43.");
        }
    }

    /** Whether `weekId` has ended and its compaction grace period has passed. */
    private compactable(weekId: string, now: number = Date.now()): boolean {
        const start: Date | undefined = isoWeekStart(weekId);
        return !!start && start.getTime() + 7 * 86_400_000 + this.compactionGraceHours * 3_600_000 <= now;
    }

    private static toIndexSegment(segment: ZeroAccessIndexSegment): IndexSegment {
        return {
            weekId: segment.weekId,
            generation: segment.generation,
            origin: segment.origin,
            bytes: segment.bytes,
            etag: segment.etag,
            schemaVersion: segment.schemaVersion,
            keyFingerprint: segment.keyFingerprint,
            entryCount: segment.entryCount,
        };
    }

    @Summary("Read a mailbox's search index manifest")
    @Description("Lists the mailbox's search index segments and, per week, the entries not yet compacted into one.")
    @Returns([Object])
    @Get("/:id/search-index/manifest")
    public async manifest(@Param("id") mailboxId: string, @AuthUser user?: JWTUser): Promise<SegmentManifest> {
        const mailbox: M = await this.requireOwnedMailbox(mailboxId, user);
        const segments: ZeroAccessIndexSegment[] = await this.segmentRepo!.find({ mailboxUid: mailbox.uid, limit: 10_000 } as any, {
            ignoreACL: true,
            limit: 10_000,
        });
        const now: number = Date.now();
        return {
            mailboxUid: mailbox.uid,
            segments: segments.map(BaseZeroAccessIndexRoute.toIndexSegment).sort((a, b) => a.weekId.localeCompare(b.weekId) || a.origin.localeCompare(b.origin)),
            weeks: (await pendingEntriesByWeek(this.entryRepo!, mailbox.uid)).map((week) => ({
                weekId: week.weekId,
                pendingEntries: week.count,
                latestEntryAt: week.latestEntryAt.toISOString(),
                compactable: this.compactable(week.weekId, now),
            })),
        };
    }

    @Summary("Read a mailbox's pending search index entries")
    @Description("Pages through the sealed index entries not yet compacted, optionally of one week and written since a time.")
    @Returns([Object])
    @Get("/:id/search-index/entries")
    public async entries(
        @Param("id") mailboxId: string,
        @Query("week") week: string | undefined,
        @Query("since") since: string | undefined,
        @Query("after") after: string | undefined,
        @Query("limit") limit: string | undefined,
        @AuthUser user?: JWTUser,
    ): Promise<SealedIndexEntryPage> {
        const mailbox: M = await this.requireOwnedMailbox(mailboxId, user);
        if (week !== undefined) {
            BaseZeroAccessIndexRoute.requireWeekId(week);
        }
        const sinceDate: Date | undefined = since !== undefined ? new Date(since) : undefined;
        if (sinceDate && Number.isNaN(sinceDate.getTime())) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "since must be an ISO 8601 date/time.");
        }
        const pageSize: number = Math.min(Math.max(Number.parseInt(limit ?? "", 10) || MAX_ENTRY_PAGE, 1), MAX_ENTRY_PAGE);
        const query: Record<string, unknown> = { mailboxUid: mailbox.uid, sort: { uid: "ASC" }, limit: pageSize + 1 };
        if (week !== undefined) {
            query.weekId = week;
        }
        if (sinceDate) {
            query.dateCreated = `gte(${sinceDate.toISOString()})`;
        }
        if (after !== undefined) {
            query.uid = `gt(${after})`;
        }
        const rows: ZeroAccessIndexEntry[] = await this.entryRepo!.find(query, { ignoreACL: true, limit: pageSize + 1 });
        const page: ZeroAccessIndexEntry[] = rows.slice(0, pageSize);
        return {
            entries: page.map((entry) => ({
                uid: entry.uid,
                weekId: entry.weekId,
                messageUid: entry.messageUid,
                createdAt: new Date(entry.dateCreated).toISOString(),
                keyFingerprint: entry.keyFingerprint,
                sealed: entry.sealed,
            })),
            ...(rows.length > pageSize ? { next: page[page.length - 1].uid } : {}),
        };
    }

    @Summary("Download a search index segment")
    @Description("The sealed file of a week's current segment generation. 404 once a newer generation replaced it.")
    @Get("/:id/search-index/segments/:weekId")
    public async getSegment(
        @Param("id") mailboxId: string,
        @Param("weekId") weekId: string,
        @Query("generation") generation: string | undefined,
        @Query("origin") origin: string | undefined,
        @Request req: HttpRequest,
        @Response res: HttpResponse,
        @AuthUser user?: JWTUser,
    ): Promise<void> {
        const mailbox: M = await this.requireOwnedMailbox(mailboxId, user);
        BaseZeroAccessIndexRoute.requireWeekId(weekId);
        const segmentOrigin: ZeroAccessSegmentOrigin = origin === "client" ? "client" : "zero-access";
        const segment: ZeroAccessIndexSegment | undefined = await this.segmentRepo!.findOne(zeroAccessSegmentUid(mailbox.uid, weekId, segmentOrigin), {
            ignoreACL: true,
            skipCache: true,
        });
        if (!segment || (generation !== undefined && String(segment.generation) !== generation)) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        const etag: string = `"${segment.etag}"`;
        res.setHeader("etag", etag);
        // A generation never changes, so the file may be kept for good; access is rechecked whenever it is fetched again.
        res.setHeader("cache-control", "private, max-age=31536000, immutable");
        const header: string | string[] | undefined = req.headers["if-none-match"];
        if ((Array.isArray(header) ? header[0] : header)?.split(",").some((candidate) => candidate.trim().replace(/^W\//, "") === etag)) {
            res.status(304).send();
            return;
        }
        const content: Buffer = await this.blobStore!.get(segment.blobKey);
        res.setHeader("content-type", "application/octet-stream");
        res.setHeader("content-length", content.length);
        res.send(content);
    }

    @Summary("Store a compacted search index segment")
    @Description(
        "Stores a week's new segment generation, built and encrypted by the client, if the week's current generation is still the one " +
            "it compacted on top of (409 otherwise), and removes the pending entries it folded in and the previous generation's file.",
    )
    @Returns([Object])
    @Put("/:id/search-index/segments/:weekId")
    public async putSegment(
        @Param("id") mailboxId: string,
        @Param("weekId") weekId: string,
        body: SegmentUpload | undefined,
        @AuthUser user?: JWTUser,
    ): Promise<IndexSegment> {
        const mailbox: M = await this.requireOwnedMailbox(mailboxId, user);
        BaseZeroAccessIndexRoute.requireWeekId(weekId);
        const origin: ZeroAccessSegmentOrigin = body?.origin ?? "zero-access";
        const folded: string[] = body?.foldedEntryUids ?? [];
        if (
            !body ||
            !Number.isInteger(body.expectedGeneration) ||
            body.expectedGeneration < 0 ||
            typeof body.segment !== "string" ||
            typeof body.keyFingerprint !== "string" ||
            !Number.isInteger(body.schemaVersion) ||
            body.schemaVersion < MIN_SCHEMA_VERSION ||
            (origin !== "zero-access" && origin !== "client") ||
            !Array.isArray(folded) ||
            folded.length > MAX_FOLDED_ENTRIES ||
            folded.some((uid) => typeof uid !== "string") ||
            (origin === "client" && folded.length > 0)
        ) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }
        if (origin === "zero-access" && !this.compactable(weekId)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "This week can't be compacted until it has ended and its grace period has passed.");
        }
        const file: Buffer = Buffer.from(body.segment, "base64");
        if (file.length === 0 || file.length > this.maxSegmentBytes) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 413, `A segment must be between 1 and ${this.maxSegmentBytes} bytes.`);
        }
        const key: ZeroAccessKey | undefined = (mailbox.zeroAccessKeys ?? []).find((k) => k.fingerprint === body.keyFingerprint);
        if (!key || !isSealedToCertificate(file, Buffer.from(key.publicKey, "base64"))) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "A segment must be encrypted to one of this mailbox's zero-access keys.");
        }

        const uid: string = zeroAccessSegmentUid(mailbox.uid, weekId, origin);
        const current: ZeroAccessIndexSegment | undefined = await this.segmentRepo!.findOne(uid, { ignoreACL: true, skipCache: true });
        if ((current?.generation ?? 0) !== body.expectedGeneration) {
            throw new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "This week's segment has changed since it was read.");
        }
        const generation: number = body.expectedGeneration + 1;
        const blobKey: string = zeroAccessSegmentBlobKey(mailbox.uid, weekId, generation, randomUUID());
        await this.blobStore!.put(blobKey, file, { contentType: "application/octet-stream" });

        const fields: Partial<ZeroAccessIndexSegment> = {
            generation,
            blobKey,
            bytes: file.length,
            etag: createHash("sha256").update(file).digest("hex"),
            schemaVersion: body.schemaVersion,
            origin,
            keyFingerprint: key.fingerprint,
            entryCount: current?.entryCount ?? 0,
        };
        let stored: ZeroAccessIndexSegment;
        try {
            stored = current
                ? await this.segmentRepo!.update({ uid, version: (current as any).version, ...fields }, current, { ignoreACL: true })
                : await this.segmentRepo!.create(new this.segmentClass({ uid, mailboxUid: mailbox.uid, weekId, ...fields }), { ignoreACL: true });
        } catch (err) {
            // Another device's compaction won (a version conflict, or the same new row created first): this file is not the week's.
            await this.blobStore!.delete(blobKey).catch(() => undefined);
            throw err instanceof ApiError && err.status !== 409
                ? err
                : new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "This week's segment has changed since it was read.");
        }

        const removed: number = await this.removeFoldedEntries(mailbox.uid, weekId, folded);
        if (removed > 0) {
            stored = await this.segmentRepo!.update(
                { uid, version: (stored as any).version, entryCount: stored.entryCount + removed },
                stored,
                { ignoreACL: true },
            );
        }
        if (current?.blobKey) {
            await this.blobStore!.delete(current.blobKey).catch((err: any) => {
                this.logger?.warn(`BaseZeroAccessIndexRoute: couldn't delete replaced segment ${current.blobKey}: ${err?.message}`);
            });
        }
        return BaseZeroAccessIndexRoute.toIndexSegment(stored);
    }

    /** Deletes the entries of `uids` that are this mailbox's for this week (anything else is ignored) and returns how many it deleted.
     * Walks the week's pending entries a page at a time rather than looking each uid up, so a large compaction costs a few reads. */
    private async removeFoldedEntries(mailboxUid: string, weekId: string, uids: string[]): Promise<number> {
        const wanted: Set<string> = new Set(uids);
        if (wanted.size === 0) {
            return 0;
        }
        const doomed: string[] = [];
        for await (const page of findPagesByUid<ZeroAccessIndexEntry>(this.entryRepo!, { mailboxUid, weekId })) {
            doomed.push(...page.filter((entry) => wanted.has(entry.uid)).map((entry) => entry.uid));
        }
        for (const uid of doomed) {
            await this.entryRepo!.delete(uid, { ignoreACL: true, purge: true });
        }
        return doomed.length;
    }
}
