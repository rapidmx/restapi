///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { Readable } from "stream";
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, ModelUtils, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { asEntity } from "../util/EntityUtils.js";
import { retainedBodyBlobKeysOf } from "../util/DraftBodyRetentionUtils.js";
import { BlobStore } from "../blob/BlobStore.js";
import { DEFAULT_MAX_EXPORT_BYTES } from "./DataExportJob.js";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { recordEscrowAuditEntry } from "../util/EscrowAuditUtils.js";
import { collectMailboxContentLines, DEFAULT_MAX_MAILBOX_CONTENT_ROWS, findPagesByUid, MailboxContentEntityClasses } from "../util/MailboxContentUtils.js";
import { AuditAction, EscrowAuditAction, Mailbox, Matter, MatterExportRequest, Message } from "../models/types.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;

/** The lease a running attempt holds on its request row - `held` is the row as of this run's last
 * version-checked write (the claim or a renewal). Same shape as `DataExportJob`'s own `ExportLease`. */
interface MatterExportLease<T> {
    held: T;
    renewedAt: number;
}

/**
 * Processes pending `MatterExportRequest` rows (see that entity's own doc comment) - mirrors
 * `DataExportJob`'s single-page-per-run shape, reusing its same `util/MailboxContentUtils.ts`
 * aggregation step once per custodian mailbox instead of once for a single mailbox.
 *
 * Each custodian mailbox's content is narrowed to the matter's own `dateRangeStart`/`dateRangeEnd`
 * (`Message.sentDate` only - see `collectMailboxContentLines()`'s own doc comment for why every other
 * entity type is still collected in full) and appended into one combined `"json"` (newline-delimited)
 * bundle. A custodian mailbox that no longer exists is skipped with a warning, not fatal to the rest of
 * the export - the same tolerance `DataExportJob`'s own `buildMboxBundle()` already shows a single
 * unreadable message.
 *
 * Every custodian mailbox actually included is logged as its own `EscrowAuditAction.MATTER_EXPORT_READY`
 * hash-chained entry (that ledger's schema is inherently one-mailbox-per-entry) once the bundle as a whole
 * is stored; a request-level failure (e.g. the `Matter` itself was deleted before this job could run) goes
 * through the ordinary `AuditAction.MATTER_EXPORT_FAILED`/`recordAuditLog()` instead, since it isn't a
 * per-mailbox content disclosure event the hash chain is meant to capture - no `mailboxUid` to attribute it
 * to at all in that case, unlike `DataExportJob.markFailed()`'s own always-single-mailboxUid failure.
 *
 * **Lease/reclaim/attempts.** Identical to `DataExportJob`'s: a request is claimed by a version-checked
 * transition to `"processing"` (bumping `processingAttempts`); the row's `dateModified` is the lease, renewed
 * after each custodian while streaming. An expired `"processing"` row is reclaimed to `"pending"` (or marked
 * `"failed"` once `processingAttempts` reaches `mail:jobs:matter_export:max_attempts`) at the start of every
 * `run()`. Bundles are written under attempt-scoped blob keys and streamed into `BlobStore.put()` (see
 * `generateBundle()` for the per-custodian memory bound), capped at `mail:export:max_bytes`.
 *
 * No legal-hold check - unlike a `purge` (see `util/LegalHoldUtils.ts`), a read-only export doesn't
 * destroy anything a hold is meant to preserve.
 *
 * Concrete entity classes are supplied by the Mongo/SQL subclasses (`MatterExportJobMongo`/
 * `MatterExportJobSQL`), following the same multi-entity-type generic pattern `DataExportJob` uses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class MatterExportJob<T extends MatterExportRequest, M extends Matter, MB extends Mailbox> extends BackgroundService {
    protected abstract matterExportRequestClass: any;
    protected abstract matterClass: any;
    protected abstract mailboxClass: any;
    protected abstract messageClass: any;
    protected abstract contactClass: any;
    protected abstract contactListClass: any;
    protected abstract calendarEventClass: any;
    protected abstract taskClass: any;
    protected abstract noteClass: any;
    protected abstract attachmentClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so this job can persist an `EscrowAuditLogEntry`
     * (per-mailbox success) and an `AuditLogEntry` (request-level failure) without depending on either
     * backend directly - see `util/EscrowAuditUtils.ts`/`util/AuditLogUtils.ts`. */
    protected abstract escrowAuditLogClass: any;
    protected abstract auditLogClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private requestRepo?: RepoUtils<T>;
    private matterRepo?: RepoUtils<M>;
    private mailboxRepo?: RepoUtils<MB>;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    @Config("mail:jobs:matter_export:schedule", "*/30 * * * * *")
    private scheduleExpr: string = "*/30 * * * * *";

    // Smaller than DataExportJob's own 10 - each request here can span many custodian mailboxes, not one.
    @Config("mail:jobs:matter_export:batch_size", 5)
    private batchSize: number = 5;

    // See `MailboxContentUtils.collectMailboxContentLines()`'s own doc comment for why this exists - applied
    // per custodian mailbox, the same as `DataExportJob`'s identical field, not to the combined bundle across
    // every custodian (a `Matter`'s custodian list is holder/admin-curated, not attacker-controlled, so
    // bounding each mailbox individually is the right compounding boundary here rather than a single
    // whole-request total). The combined bundle is instead bounded by `maxBytes` below.
    @Config("mail:jobs:matter_export:max_content_rows", DEFAULT_MAX_MAILBOX_CONTENT_ROWS)
    private maxContentRows: number = DEFAULT_MAX_MAILBOX_CONTENT_ROWS;

    /** How long a request may sit in `"processing"` without its lease being renewed before it is presumed
     * abandoned (the processing replica died) and reclaimed - see `DataExportJob`'s identical `lease_minutes`. */
    @Config("mail:jobs:matter_export:lease_minutes", 60)
    private leaseMinutes: number = 60;

    /** How many claims a request gets before an abandoned `"processing"` row is marked `"failed"` instead of
     * being reclaimed for another attempt. */
    @Config("mail:jobs:matter_export:max_attempts", 3)
    private maxAttempts: number = 3;

    /** Total byte ceiling for one combined export bundle - shared with `DataExportJob` (default 2 GiB). */
    @Config("mail:export:max_bytes", DEFAULT_MAX_EXPORT_BYTES)
    private maxBytes: number = DEFAULT_MAX_EXPORT_BYTES;

    /** The whole application config, needed only to pass through to `recordAuditLog()` (`caller.config`). */
    @Config()
    private config: any;

    @Logger
    private logger: any;

    public get schedule(): string | undefined {
        return this.scheduleExpr;
    }

    @Init
    public async init(): Promise<void> {
        this.requestRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.matterExportRequestClass.name,
            args: [this.matterExportRequestClass],
        });
        this.matterRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.matterClass.name,
            args: [this.matterClass],
        });
        this.mailboxRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.mailboxClass.name,
            args: [this.mailboxClass],
        });
    }

    public async start(): Promise<void> {
        // Nothing to do at startup beyond `init()` above; processing happens entirely in `run()`.
    }

    public stop(): Promise<void> | void {
        // Do nothing
    }

    public async run(): Promise<void> {
        if (!this.requestRepo || !this.matterRepo || !this.mailboxRepo || !this.blobStore) {
            return;
        }

        await this.reclaimAbandonedRequests();

        const pending: T[] = await this.requestRepo.find(
            { status: "pending", limit: this.batchSize } as any,
            { ignoreACL: true, limit: this.batchSize },
        );

        for (const request of pending) {
            try {
                await this.processRequest(request);
            } catch (err: any) {
                this.logger?.error(`MatterExportJob: failed to process export request ${request.uid}: ${err.message}`);
                await this.markFailed(request, err.message);
            }
        }
    }

    private get leaseMs(): number {
        return this.leaseMinutes * 60_000;
    }

    /** Reclaims `"processing"` rows whose lease (`dateModified`) expired - identical to `DataExportJob.
     * reclaimAbandonedRequests()`. Every transition is version-checked against the row as just read
     * (`asEntity()`), so when two replicas race to reclaim the same row exactly one wins; the loser's update
     * throws and is merely logged. */
    private async reclaimAbandonedRequests(): Promise<void> {
        const cutoff: Date = new Date(Date.now() - this.leaseMs);
        let abandoned: T[];
        try {
            abandoned = await this.requestRepo!.find(
                { status: "processing", dateModified: `lt(${cutoff.toISOString()})`, limit: this.batchSize } as any,
                { ignoreACL: true, limit: this.batchSize },
            );
        } catch (err: any) {
            this.logger?.warn(`MatterExportJob: failed to look up abandoned export requests: ${err.message}`);
            return;
        }
        for (const request of abandoned) {
            // A "processing" row has had at least one claim, even if the counter is somehow missing/0.
            const attempts: number = Math.max(1, request.processingAttempts ?? 0);
            try {
                if (attempts >= this.maxAttempts) {
                    this.logger?.warn(`MatterExportJob: export request ${request.uid} abandoned after ${attempts} attempt(s); marking failed.`);
                    await this.transitionToFailed(request, `The export did not complete after ${attempts} attempt(s) - processing was interrupted each time.`);
                } else {
                    this.logger?.warn(`MatterExportJob: reclaiming abandoned export request ${request.uid} (attempt ${attempts} of ${this.maxAttempts}).`);
                    await this.requestRepo!.update(
                        { uid: request.uid, version: (request as any).version, status: "pending" } as any,
                        asEntity(this.requestRepo!, request),
                        { ignoreACL: true },
                    );
                }
            } catch (err: any) {
                this.logger?.warn(`MatterExportJob: failed to reclaim abandoned export request ${request.uid}: ${err.message}`);
            }
        }
    }

    /** Renews this attempt's lease (a version-checked write that bumps `dateModified`) once a quarter of the
     * lease period has elapsed since the last renewal. Throws - aborting the export - if the row's version
     * moved underneath it, i.e. the lease was lost to a reclaim. */
    private async renewLease(lease: MatterExportLease<T>): Promise<void> {
        if (Date.now() - lease.renewedAt < this.leaseMs / 4) {
            return;
        }
        lease.held = await this.requestRepo!.update(
            { uid: lease.held.uid, version: (lease.held as any).version, status: "processing" } as any,
            asEntity(this.requestRepo!, lease.held),
            { ignoreACL: true },
        );
        lease.renewedAt = Date.now();
    }

    private get contentEntityClasses(): MailboxContentEntityClasses {
        return {
            message: this.messageClass,
            contact: this.contactClass,
            contactList: this.contactListClass,
            calendarEvent: this.calendarEventClass,
            task: this.taskClass,
            note: this.noteClass,
            attachment: this.attachmentClass,
        };
    }

    private async processRequest(request: T): Promise<void> {
        const matter: M | undefined = await this.matterRepo!.findOne(request.matterId, { ignoreACL: true });
        if (!matter) {
            await this.markFailed(request, "The requested matter no longer exists.");
            return;
        }

        // Claimed via a version-checked transition to "processing" BEFORE any content is collected or any blob
        // written (the same "claim first, work second" discipline as `DataExportJob.processRequest()`): a
        // losing overlapping run's claim throws here (caught by `run()`) and never builds a bundle. The claim
        // starts this attempt's lease (`dateModified`) and bumps `processingAttempts`.
        const attempt: number = (request.processingAttempts ?? 0) + 1;
        const lease: MatterExportLease<T> = {
            held: await this.requestRepo!.update(
                { uid: request.uid, version: (request as any).version, status: "processing", processingAttempts: attempt } as any,
                asEntity(this.requestRepo!, request),
                { ignoreACL: true },
            ),
            renewedAt: Date.now(),
        };

        // Filled while streaming and only actually recorded (below) once the export bundle as a whole has
        // been successfully written and the request marked "ready" - see this class's own doc comment. Each
        // `EscrowAuditLogEntry` is a permanent, hash-chained attestation that a specific mailbox's content
        // was included in a completed, downloadable export; recording it any earlier (e.g. immediately
        // after that one mailbox's own content was collected) would let a LATER custodian's failure - a
        // `collectMailboxContentLines()` row-cap overrun, a transient DB/blob error - mark the whole
        // request "failed" while leaving behind a permanent, unfixable record falsely attesting that an
        // export completed for the mailboxes already processed.
        const includedMailboxUids: string[] = [];
        // Attempt-scoped, so a stale run from an earlier (reclaimed) attempt can never overwrite this
        // attempt's bundle, nor this one the next attempt's.
        const blobKey = `matter-exports/${request.uid}-${attempt}.ndjson`;

        // Every failure from here on must mark against the currently-held lease version, not `request`'s stale
        // pre-claim one (which `run()`'s outer catch would use, and simply fail a second time).
        let blobStored = false;
        try {
            try {
                await this.blobStore!.put(blobKey, Readable.from(this.generateBundle(matter, request.uid, lease, includedMailboxUids)), {
                    contentType: "application/x-ndjson",
                });
                blobStored = true;
            } catch (err: any) {
                // A stream that errors mid-put can leave a partial blob behind - never referenced, deleted here.
                await this.deleteBlobQuietly(blobKey);
                throw err;
            }

            // Version-checked against the lease this run still holds (renewed while streaming), deliberately
            // NOT a re-fetch: if this attempt's lease expired and another replica reclaimed the request, this
            // update must lose rather than stamp "ready" over the newer attempt.
            await this.requestRepo!.update(
                { uid: lease.held.uid, version: (lease.held as any).version, status: "ready", blobKey } as any,
                asEntity(this.requestRepo!, lease.held),
                { ignoreACL: true },
            );
            blobStored = false;
        } catch (err: any) {
            if (blobStored) {
                // The bundle was stored but the request never reached "ready" - nothing references the blob.
                await this.deleteBlobQuietly(blobKey);
            }
            this.logger?.error(`MatterExportJob: failed to process export request ${request.uid}: ${err.message}`);
            await this.markFailed(lease.held, err.message);
            return;
        }

        // Best-effort per mailbox, deliberately NOT allowed to throw out of `processRequest()` - the
        // request is already genuinely `"ready"` (the bundle above is real, stored, and downloadable) by
        // this point, so a failure here (e.g. `recordEscrowAuditEntry()`'s own sequence-contention retries
        // exhausted under a concurrent writer) must not route through `run()`'s `catch`/`markFailed()`:
        // that would try to write a STALE pre-"ready" version, itself fail its own optimistic-lock check,
        // and get silently swallowed. Logged loudly instead, so the gap is at least operator-visible rather
        // than a silent, permanent hole in the hash-chained ledger.
        for (const mailboxUid of includedMailboxUids) {
            try {
                await recordEscrowAuditEntry(this._objectFactory!, this.escrowAuditLogClass, {
                    action: EscrowAuditAction.MATTER_EXPORT_READY,
                    holderUserUid: request.requestedByUserUid,
                    matterId: matter.uid,
                    mailboxUid,
                    requestId: request.uid,
                });
            } catch (err: any) {
                this.logger?.error(
                    `MatterExportJob: request ${request.uid} is ready and its bundle already includes mailbox ${mailboxUid}'s content, but recording that mailbox's own EscrowAuditLogEntry attestation failed and will NOT be retried: ${err.message}`,
                );
            }
        }
    }

    /**
     * Yields the NDJSON bundle one custodian mailbox at a time, fed through `Readable.from()` straight into
     * `BlobStore.put()` - the combined bundle across every custodian is never held in memory, nor joined into a
     * second full-size string copy. Memory is bounded to ONE custodian's collected lines at a time
     * (`collectMailboxContentLines()` returns an array, itself capped at `max_content_rows`); a fully
     * row-by-row stream would need a generator variant of that shared helper. The lease is renewed after
     * each custodian, so a long multi-custodian export isn't mistaken for an abandoned one. Throws (erroring
     * the stream, rejecting the `put()`) on a `mail:export:max_bytes` overrun rather than truncating.
     */
    private async *generateBundle(matter: M, requestUid: string, lease: MatterExportLease<T>, includedMailboxUids: string[]): AsyncGenerator<Buffer> {
        const dateRange = { start: matter.dateRangeStart, end: matter.dateRangeEnd };
        let bytes = 0;
        let first = true;
        for (const mailboxUid of matter.custodianMailboxUids) {
            const mailbox: MB | undefined = await this.mailboxRepo!.findOne(mailboxUid, { ignoreACL: true });
            if (!mailbox) {
                this.logger?.warn(`MatterExportJob: skipping custodian mailbox ${mailboxUid} for request ${requestUid} - it no longer exists.`);
                continue;
            }
            // `custodianMailboxUids` is holder-set, unvalidated free text (`BaseMatterRoute`'s own
            // `validateMatter()` only checks it's a non-empty array of non-empty strings) - without this
            // check, any holder of any `EscrowScope` could list an arbitrary mailbox as a "custodian" on
            // their own matter and export its full content, bypassing the real "both must agree" binding
            // `BaseEscrowAccessRequestRoute.create()` already enforces before opening genuine escrow
            // access (see `Matter.custodianMailboxUids`'s own doc comment).
            if (mailbox.escrowScopeId !== matter.escrowScopeId) {
                this.logger?.warn(
                    `MatterExportJob: skipping custodian mailbox ${mailboxUid} for request ${requestUid} - it is not actually assigned to this matter's escrow scope.`,
                );
                continue;
            }
            const lines: string[] = await collectMailboxContentLines(
                this._objectFactory!,
                this.contentEntityClasses,
                mailboxUid,
                mailbox,
                dateRange,
                this.maxContentRows,
            );
            const emit = (line: string): Buffer => {
                const chunk: Buffer = Buffer.from(first ? line : `\n${line}`, "utf-8");
                first = false;
                bytes += chunk.length;
                if (bytes > this.maxBytes) {
                    throw new Error(`Export exceeds the maximum export size of ${this.maxBytes} bytes.`);
                }
                return chunk;
            };
            for (let i = 0; i < lines.length; i++) {
                yield emit(lines[i]);
            }
            for await (const line of this.retainedDraftBodyLines(mailboxUid, dateRange)) {
                yield emit(line);
            }
            includedMailboxUids.push(mailboxUid);
            await this.renewLease(lease);
        }
    }

    /**
     * One `retainedDraftBody` line per draft body kept for a legal hold (`Message.retainedBodyBlobKeys`, see
     * `util/DraftBodyRetentionUtils.ts`) on the custodian's messages in the matter's date range - the same messages the
     * bundle's `message` lines cover. Nothing else references those blobs, so without this the superseded draft content
     * a hold preserves could never be produced. Each line carries the raw RFC 5322 source base64-encoded (`content`), or
     * `missing: true` when the blob can't be read. One message page and one body are held at a time.
     */
    private async *retainedDraftBodyLines(mailboxUid: string, dateRange: { start: Date; end: Date }): AsyncGenerator<string> {
        const repo: RepoUtils<any> = await this._objectFactory!.newInstance(RepoUtils, { name: this.messageClass.name, args: [this.messageClass] });
        const criteria: Record<string, any> = {
            mailboxUid: ModelUtils.literal(mailboxUid),
            retainedBodyBlobKeys: "ne(null)",
            sentDate: `range(${new Date(dateRange.start).toISOString()},${new Date(dateRange.end).toISOString()})`,
        };
        for await (const messages of findPagesByUid<Message>(repo, criteria)) {
            for (const message of messages) {
                for (const blobKey of retainedBodyBlobKeysOf(message)) {
                    const line: Record<string, unknown> = { entityType: "retainedDraftBody", messageUid: message.uid, mailboxUid, blobKey };
                    try {
                        const content: Buffer = await this.blobStore!.get(blobKey);
                        Object.assign(line, { contentType: "message/rfc822", encoding: "base64", content: content.toString("base64") });
                    } catch (err: any) {
                        this.logger?.warn(`MatterExportJob: retained draft body ${blobKey} of message ${message.uid} could not be read: ${err.message}`);
                        line.missing = true;
                    }
                    yield JSON.stringify(line);
                }
            }
        }
    }

    private async deleteBlobQuietly(blobKey: string): Promise<void> {
        try {
            await this.blobStore!.delete(blobKey);
        } catch (err: any) {
            this.logger?.warn(`MatterExportJob: failed to delete incomplete export blob ${blobKey}: ${err.message}`);
        }
    }

    private async markFailed(request: T, errorMessage: string): Promise<void> {
        try {
            await this.transitionToFailed(request, errorMessage);
        } catch (err: any) {
            this.logger?.error(`MatterExportJob: failed to mark export request ${request.uid} as failed: ${err.message}`);
        }
    }

    private async transitionToFailed(request: T, errorMessage: string): Promise<void> {
        const updated: T = await this.requestRepo!.update(
            { uid: request.uid, version: (request as any).version, status: "failed", errorMessage } as any,
            asEntity(this.requestRepo!, request),
            { ignoreACL: true },
        );
        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, logger: this.logger },
            { action: AuditAction.MATTER_EXPORT_FAILED, targetType: "MatterExportRequest", targetUid: updated.uid },
        );
    }
}
