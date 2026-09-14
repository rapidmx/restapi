///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { Readable } from "stream";
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { asEntity } from "../util/EntityUtils.js";
import { BlobStore } from "../blob/BlobStore.js";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { collectMailboxContentLines, DEFAULT_MAX_MAILBOX_CONTENT_ROWS, MailboxContentEntityClasses } from "../util/MailboxContentUtils.js";
import { buildMboxEntry } from "../util/MboxUtils.js";
import { AuditAction, DataExportRequest, Mailbox, Message } from "../models/types.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;

/** Default `mail:export:max_bytes` - 2 GiB. */
export const DEFAULT_MAX_EXPORT_BYTES = 2_147_483_648;

function exportTooLargeMessage(maxBytes: number): string {
    return `Export exceeds the maximum export size of ${maxBytes} bytes.`;
}

/** The lease a running attempt holds on its request row - `held` is the row as of this run's last
 * version-checked write (the claim or a renewal). */
interface ExportLease<DER> {
    held: DER;
    renewedAt: number;
}

/**
 * Processes pending `DataExportRequest` rows (see that entity's own doc comment) - a mailbox's full
 * content can be large, so this runs asynchronously rather than inline with the request. Mirrors
 * `QuarantineRetentionJob`'s single-page-per-run shape.
 *
 * `"mbox"` format concatenates every `Message.bodyBlobKey`'s already-stored raw RFC 5322 source via
 * `util/MboxUtils.ts` - a real, interoperable mail export. `"json"` format is the GDPR-portability
 * bundle: every row across `Mailbox`/`Message`/`Contact`/`ContactList`/`CalendarEvent`/`Task`/`Note`/
 * `Attachment` this mailbox owns, one JSON object per line (newline-delimited, matching how `BlobStore`
 * already stores opaque byte payloads - no new storage abstraction needed). `AuditLogEntry` rows
 * referencing this mailbox are deliberately NOT included in this pass - "referencing" is a fuzzier,
 * many-target-types concept than a direct `mailboxUid` filter, and a clear fast-follow rather than
 * something to approximate poorly now.
 *
 * The aggregation step (`util/MailboxContentUtils.ts`'s `collectMailboxContentLines()`) is deliberately
 * not hard-wired to "one mailbox" - `MatterExportJob` reuses it per custodian mailbox for a Matter-scoped
 * eDiscovery export.
 *
 * **Lease/reclaim.** A request is claimed by a version-checked transition to `"processing"` (which also
 * bumps `processingAttempts`); the row's own `dateModified` is the lease timestamp. A long-running mbox
 * export renews that lease as it streams (another version-checked write), so a live run is never mistaken
 * for a dead one. At the start of every `run()`, any `"processing"` row whose lease is older than
 * `lease_minutes` - i.e. the replica working on it died mid-run - is reclaimed back to `"pending"` (or
 * marked `"failed"` once `processingAttempts` has reached `max_attempts`), again via a version-checked
 * update so two replicas can never both reclaim the same row. A stale run that somehow outlives a reclaim
 * loses its next lease renewal/final transition on the version check and stops without touching the row;
 * each attempt writes its bundle under its own attempt-scoped blob key, so it can't clobber the new
 * attempt's output either.
 *
 * **Size bounds.** Both formats are capped at `max_content_rows` rows. `"mbox"` is streamed straight into
 * `BlobStore.put()` one message at a time (never buffered whole) and capped at `mail:export:max_bytes`
 * total bytes; `"json"` is checked against the same byte limit. Exceeding either fails the request with a
 * clear message rather than producing a silently truncated bundle, and any partially written blob is
 * deleted (never referenced from the request).
 *
 * Concrete entity classes are supplied by the Mongo/SQL subclasses (`DataExportJobMongo`/
 * `DataExportJobSQL`), following the same multi-entity-type generic pattern `ScanQueueJob` uses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class DataExportJob<DER extends DataExportRequest, MB extends Mailbox> extends BackgroundService {
    protected abstract dataExportRequestClass: any;
    protected abstract mailboxClass: any;
    protected abstract messageClass: any;
    protected abstract contactClass: any;
    protected abstract contactListClass: any;
    protected abstract calendarEventClass: any;
    protected abstract taskClass: any;
    protected abstract noteClass: any;
    protected abstract attachmentClass: any;
    protected abstract auditLogClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private dataExportRequestRepo?: RepoUtils<DER>;
    private mailboxRepo?: RepoUtils<MB>;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    @Config("mail:jobs:data_export:schedule", "*/30 * * * * *")
    private scheduleExpr: string = "*/30 * * * * *";

    @Config("mail:jobs:data_export:batch_size", 10)
    private batchSize: number = 10;

    // See `MailboxContentUtils.collectMailboxContentLines()`'s own doc comment for why this exists.
    @Config("mail:jobs:data_export:max_content_rows", DEFAULT_MAX_MAILBOX_CONTENT_ROWS)
    private maxContentRows: number = DEFAULT_MAX_MAILBOX_CONTENT_ROWS;

    /** How long a request may sit in `"processing"` without its lease being renewed before it is presumed
     * abandoned (the processing replica died) and reclaimed - see this class's own doc comment. */
    @Config("mail:jobs:data_export:lease_minutes", 60)
    private leaseMinutes: number = 60;

    /** How many claims a request gets before an abandoned `"processing"` row is marked `"failed"` instead of
     * being reclaimed for another attempt. */
    @Config("mail:jobs:data_export:max_attempts", 3)
    private maxAttempts: number = 3;

    /** Total byte ceiling for one export bundle (default 2 GiB). */
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
        this.dataExportRequestRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.dataExportRequestClass.name,
            args: [this.dataExportRequestClass],
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
        if (!this.dataExportRequestRepo || !this.mailboxRepo || !this.blobStore) {
            return;
        }

        await this.reclaimAbandonedRequests();

        const pending: DER[] = await this.dataExportRequestRepo.find(
            { status: "pending", limit: this.batchSize } as any,
            { ignoreACL: true, limit: this.batchSize },
        );

        for (const request of pending) {
            try {
                await this.processRequest(request);
            } catch (err: any) {
                this.logger?.error(`DataExportJob: failed to process export request ${request.uid}: ${err.message}`);
                await this.markFailed(request, err.message);
            }
        }
    }

    private get leaseMs(): number {
        return this.leaseMinutes * 60_000;
    }

    /** Reclaims `"processing"` rows whose lease (`dateModified`) expired - see this class's own doc comment.
     * Every transition is version-checked against the row as just read, so when two replicas race to reclaim
     * the same row exactly one wins; the loser's update throws and is merely logged. */
    private async reclaimAbandonedRequests(): Promise<void> {
        const cutoff: Date = new Date(Date.now() - this.leaseMs);
        let abandoned: DER[];
        try {
            abandoned = await this.dataExportRequestRepo!.find(
                { status: "processing", dateModified: `lt(${cutoff.toISOString()})`, limit: this.batchSize } as any,
                { ignoreACL: true, limit: this.batchSize },
            );
        } catch (err: any) {
            this.logger?.warn(`DataExportJob: failed to look up abandoned export requests: ${err.message}`);
            return;
        }
        for (const request of abandoned) {
            // A row claimed before `processingAttempts` existed has had (at least) one attempt.
            const attempts: number = request.processingAttempts ?? 1;
            try {
                if (attempts >= this.maxAttempts) {
                    this.logger?.warn(`DataExportJob: export request ${request.uid} abandoned after ${attempts} attempt(s); marking failed.`);
                    await this.transitionToFailed(request, `The export did not complete after ${attempts} attempt(s) - processing was interrupted each time.`);
                } else {
                    this.logger?.warn(`DataExportJob: reclaiming abandoned export request ${request.uid} (attempt ${attempts} of ${this.maxAttempts}).`);
                    await this.dataExportRequestRepo!.update(
                        { uid: request.uid, version: (request as any).version, status: "pending" } as any,
                        asEntity(this.dataExportRequestRepo!, request),
                        { ignoreACL: true },
                    );
                }
            } catch (err: any) {
                this.logger?.warn(`DataExportJob: failed to reclaim abandoned export request ${request.uid}: ${err.message}`);
            }
        }
    }

    private async processRequest(request: DER): Promise<void> {
        const mailbox: MB | undefined = await this.mailboxRepo!.findOne(request.mailboxUid, { ignoreACL: true });
        if (!mailbox) {
            await this.markFailed(request, "The requested mailbox no longer exists.");
            return;
        }

        // Claimed via an optimistic-locked transition to "processing" BEFORE any bundle building/blob
        // writing happens - the same "claim first, work second" discipline `MailboxImportJob.
        // processRequest()` already establishes. Without this, two overlapping runs (a real possibility in
        // a multi-node deployment, or one run overlapping the next poll) could both build a bundle and both
        // `blobStore.put()` - a non-transactional side effect independent of whichever run's own `update()`
        // to "ready" wins the DB's optimistic lock. Claiming first means a losing run's own `update()` here
        // throws immediately (caught by `run()`'s own catch) and never reaches the bundle/blob step at all.
        // The claim also starts this attempt's lease (`dateModified`) and bumps `processingAttempts`.
        const attempt: number = (request.processingAttempts ?? 0) + 1;
        const lease: ExportLease<DER> = {
            held: await this.dataExportRequestRepo!.update(
                { uid: request.uid, version: (request as any).version, status: "processing", processingAttempts: attempt } as any,
                asEntity(this.dataExportRequestRepo!, request),
                { ignoreACL: true },
            ),
            renewedAt: Date.now(),
        };
        const processing: DER = lease.held;

        // Attempt-scoped, so a stale run from an earlier (reclaimed) attempt can never overwrite this
        // attempt's bundle, nor this one the next attempt's.
        const blobKey = `data-exports/${processing.uid}-${attempt}.${processing.format === "mbox" ? "mbox" : "ndjson"}`;
        const contentType: string = processing.format === "mbox" ? "application/mbox" : "application/x-ndjson";

        // Wrapped in its own try/catch, deliberately NOT left to `run()`'s own outer catch (which would
        // call `markFailed(request, ...)` using `request`'s now-stale pre-claim version and simply fail a
        // second time) - every failure from here on must mark against the currently-held lease version.
        let blobStored = false;
        try {
            try {
                if (processing.format === "mbox") {
                    const messageRepo: RepoUtils<any> = await this.getRepo(this.messageClass);
                    await this.blobStore!.put(blobKey, Readable.from(this.generateMbox(messageRepo, processing.mailboxUid, lease)), { contentType });
                } else {
                    await this.blobStore!.put(blobKey, await this.buildJsonBundle(processing.mailboxUid, mailbox), { contentType });
                }
                blobStored = true;
            } catch (err: any) {
                // A stream that errors mid-put can leave a partial blob behind (e.g. `LocalFsBlobStore`'s write
                // stream has already created the file) - it is never referenced from the request, and is
                // deleted here so it doesn't linger either.
                await this.deleteBlobQuietly(blobKey);
                throw err;
            }

            // Version-checked against the lease this run still holds (renewed while streaming), deliberately
            // NOT a re-fetch: if this attempt's lease expired and another replica reclaimed the request, this
            // update must lose rather than stamp "ready" over the newer attempt.
            const updated: DER = await this.dataExportRequestRepo!.update(
                { uid: lease.held.uid, version: (lease.held as any).version, status: "ready", blobKey } as any,
                asEntity(this.dataExportRequestRepo!, lease.held),
                { ignoreACL: true },
            );
            blobStored = false;
            await recordAuditLog(
                this._objectFactory!,
                this.auditLogClass,
                { config: this.config, logger: this.logger },
                { action: AuditAction.DATA_EXPORT_READY, targetType: "DataExportRequest", targetUid: updated.uid, mailboxUid: updated.mailboxUid },
            );
        } catch (err: any) {
            if (blobStored) {
                // The bundle was stored but the request never reached "ready" - nothing references the blob.
                await this.deleteBlobQuietly(blobKey);
            }
            await this.markFailed(lease.held, err.message);
        }
    }

    /** Renews this attempt's lease (a version-checked write that bumps `dateModified`) once a quarter of the
     * lease period has elapsed since the last renewal. Throws - aborting the export - if the row's version
     * moved underneath it, i.e. the lease was lost to a reclaim. */
    private async renewLease(lease: ExportLease<DER>): Promise<void> {
        if (Date.now() - lease.renewedAt < this.leaseMs / 4) {
            return;
        }
        lease.held = await this.dataExportRequestRepo!.update(
            { uid: lease.held.uid, version: (lease.held as any).version, status: "processing" } as any,
            asEntity(this.dataExportRequestRepo!, lease.held),
            { ignoreACL: true },
        );
        lease.renewedAt = Date.now();
    }

    private async deleteBlobQuietly(blobKey: string): Promise<void> {
        try {
            await this.blobStore!.delete(blobKey);
        } catch (err: any) {
            this.logger?.warn(`DataExportJob: failed to delete incomplete export blob ${blobKey}: ${err.message}`);
        }
    }

    private async markFailed(request: DER, errorMessage: string): Promise<void> {
        try {
            await this.transitionToFailed(request, errorMessage);
        } catch (err: any) {
            this.logger?.error(`DataExportJob: failed to mark export request ${request.uid} as failed: ${err.message}`);
        }
    }

    private async transitionToFailed(request: DER, errorMessage: string): Promise<void> {
        const updated: DER = await this.dataExportRequestRepo!.update(
            { uid: request.uid, version: (request as any).version, status: "failed", errorMessage } as any,
            asEntity(this.dataExportRequestRepo!, request),
            { ignoreACL: true },
        );
        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, logger: this.logger },
            { action: AuditAction.DATA_EXPORT_FAILED, targetType: "DataExportRequest", targetUid: updated.uid, mailboxUid: updated.mailboxUid },
        );
    }

    private async getRepo(entityClass: any): Promise<RepoUtils<any>> {
        return await this._objectFactory!.newInstance(RepoUtils, { name: entityClass.name, args: [entityClass] });
    }

    /** Yields one mbox entry per message, paging through `repo.find()` (a bare, unpaginated `find()` silently
     * truncates at 100 rows - see `MailboxQuotaRecalcJob.findAllPages()`) and reading each message's body blob
     * only when its entry is about to be emitted, so at most one page of rows and one message body are held in
     * memory at a time. Fed through `Readable.from()` straight into `BlobStore.put()`.
     *
     * Bounded by `this.maxContentRows` (checked per page) and `this.maxBytes` (checked per entry). Throwing
     * from here errors the stream, which rejects the `put()`; both caps throw rather than silently truncating -
     * a partial export that looks complete is worse than one that visibly failed. A message whose body can't
     * be read is skipped with a warning, not fatal to the rest of the export. */
    private async *generateMbox(messageRepo: RepoUtils<any>, mailboxUid: string, lease: ExportLease<DER>, pageSize: number = 500): AsyncGenerator<Buffer> {
        let rows = 0;
        let bytes = 0;
        for (let page = 0; ; page++) {
            const batch: Message[] = await messageRepo.find({ mailboxUid, limit: pageSize, page } as any, { ignoreACL: true, limit: pageSize, page });
            rows += batch.length;
            if (rows > this.maxContentRows) {
                throw new Error(`Mailbox ${mailboxUid}'s content exceeds the maximum of ${this.maxContentRows} exportable rows.`);
            }
            for (const message of batch) {
                let entry: Buffer;
                try {
                    const raw: Buffer = await this.blobStore!.get(message.bodyBlobKey);
                    entry = buildMboxEntry(raw, message.from.address, message.sentDate);
                } catch (err: any) {
                    this.logger?.warn(`DataExportJob: skipping message ${message.uid} in mbox export - failed to read body: ${err.message}`);
                    continue;
                }
                bytes += entry.length;
                if (bytes > this.maxBytes) {
                    throw new Error(exportTooLargeMessage(this.maxBytes));
                }
                yield entry;
            }
            await this.renewLease(lease);
            if (batch.length < pageSize) {
                break;
            }
        }
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

    private async buildJsonBundle(mailboxUid: string, mailbox: MB): Promise<Buffer> {
        const lines: string[] = await collectMailboxContentLines(
            this._objectFactory!,
            this.contentEntityClasses,
            mailboxUid,
            mailbox,
            undefined,
            this.maxContentRows,
        );
        // Checked before joining, so an oversized bundle never costs a second full-size copy.
        let bytes: number = Math.max(0, lines.length - 1); // "\n" separators
        for (const line of lines) {
            bytes += Buffer.byteLength(line, "utf-8");
            if (bytes > this.maxBytes) {
                throw new Error(exportTooLargeMessage(this.maxBytes));
            }
        }
        return Buffer.from(lines.join("\n"), "utf-8");
    }
}
