///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { BlobStore } from "../blob/BlobStore.js";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { collectMailboxContentLines, DEFAULT_MAX_MAILBOX_CONTENT_ROWS, MailboxContentEntityClasses } from "../util/MailboxContentUtils.js";
import { buildMboxEntry } from "../util/MboxUtils.js";
import { AuditAction, DataExportRequest, Mailbox, Message } from "../models/types.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;

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
        // `blobStore.put()` the SAME deterministic key - a non-transactional side effect independent of
        // whichever run's own `update()` to "ready" wins the DB's optimistic lock, so the request could end
        // up "ready" with an audit entry describing one run's completion while the downloadable bytes are
        // actually the other run's output. Claiming first means a losing run's own `update()` here throws
        // immediately (caught by `run()`'s own catch) and never reaches the bundle/blob step at all.
        const processing: DER = await this.dataExportRequestRepo!.update(
            { uid: request.uid, version: (request as any).version, status: "processing" } as any,
            request,
            { ignoreACL: true },
        );

        // Wrapped in its own try/catch, deliberately NOT left to `run()`'s own outer catch (which would
        // call `markFailed(request, ...)` using `request`'s now-stale pre-claim version and simply fail a
        // second time) - every failure from here on must mark against `processing`'s own version, the same
        // discipline `MailboxImportJob.processRequest()` already establishes for its identical shape.
        try {
            const content: Buffer =
                processing.format === "mbox"
                    ? await this.buildMboxBundle(processing.mailboxUid)
                    : await this.buildJsonBundle(processing.mailboxUid, mailbox);
            const blobKey = `data-exports/${processing.uid}.${processing.format === "mbox" ? "mbox" : "ndjson"}`;
            await this.blobStore!.put(blobKey, content, {
                contentType: processing.format === "mbox" ? "application/mbox" : "application/x-ndjson",
            });

            // Re-fetched rather than reusing `processing`'s own version - `MailboxImportJob.
            // processRequest()`'s identical final transition documents why: the bundle build above can take
            // long enough that trusting a version fetched before it risks a spurious conflict against a
            // completely unrelated concurrent write to this same row, even though nothing here actually raced.
            const refetched: DER = (await this.dataExportRequestRepo!.findOne(processing.uid, { ignoreACL: true }))!;
            const updated: DER = await this.dataExportRequestRepo!.update(
                { uid: refetched.uid, version: (refetched as any).version, status: "ready", blobKey } as any,
                refetched,
                { ignoreACL: true },
            );
            await recordAuditLog(
                this._objectFactory!,
                this.auditLogClass,
                { config: this.config, logger: this.logger },
                { action: AuditAction.DATA_EXPORT_READY, targetType: "DataExportRequest", targetUid: updated.uid, mailboxUid: updated.mailboxUid },
            );
        } catch (err: any) {
            await this.markFailed(processing, err.message);
        }
    }

    private async markFailed(request: DER, errorMessage: string): Promise<void> {
        try {
            const updated: DER = await this.dataExportRequestRepo!.update(
                { uid: request.uid, version: (request as any).version, status: "failed", errorMessage } as any,
                request,
                { ignoreACL: true },
            );
            await recordAuditLog(
                this._objectFactory!,
                this.auditLogClass,
                { config: this.config, logger: this.logger },
                { action: AuditAction.DATA_EXPORT_FAILED, targetType: "DataExportRequest", targetUid: updated.uid, mailboxUid: updated.mailboxUid },
            );
        } catch (err: any) {
            this.logger?.error(`DataExportJob: failed to mark export request ${request.uid} as failed: ${err.message}`);
        }
    }

    private async getRepo(entityClass: any): Promise<RepoUtils<any>> {
        return await this._objectFactory!.newInstance(RepoUtils, { name: entityClass.name, args: [entityClass] });
    }

    /** Fetches every page of `repo.find(criteria, ...)` results - see `MailboxQuotaRecalcJob.
     * findAllPages()`'s identical rationale (a bare, unpaginated `find()` silently truncates at 100
     * rows). A mailbox's own export must be complete, not a sample. */
    private async findAllPages(repo: RepoUtils<any>, criteria: Record<string, any>, pageSize: number = 500): Promise<any[]> {
        const all: any[] = [];
        for (let page = 0; ; page++) {
            const batch: any[] = await repo.find({ ...criteria, limit: pageSize, page } as any, { ignoreACL: true, limit: pageSize, page });
            all.push(...batch);
            if (batch.length < pageSize) {
                break;
            }
        }
        return all;
    }

    private async buildMboxBundle(mailboxUid: string): Promise<Buffer> {
        const messageRepo: RepoUtils<any> = await this.getRepo(this.messageClass);
        const messages: Message[] = await this.findAllPages(messageRepo, { mailboxUid });

        const entries: Buffer[] = [];
        for (const message of messages) {
            try {
                const raw: Buffer = await this.blobStore!.get(message.bodyBlobKey);
                entries.push(buildMboxEntry(raw, message.from.address, message.sentDate));
            } catch (err: any) {
                this.logger?.warn(`DataExportJob: skipping message ${message.uid} in mbox export - failed to read body: ${err.message}`);
            }
        }
        return Buffer.concat(entries);
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
        return Buffer.from(lines.join("\n"), "utf-8");
    }
}
