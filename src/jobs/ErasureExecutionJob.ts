///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { BlobStore } from "../blob/BlobStore.js";
import { assertNotOnLegalHold } from "../util/LegalHoldUtils.js";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { AuditAction, DataSubjectErasureRequest, Mailbox } from "../models/types.js";
import { isMailboxScopedData } from "../plugins/PluginRegistry.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;

/**
 * Processes `DataSubjectErasureRequest` rows an admin has already approved (see that entity's own doc
 * comment for why the cascade is async rather than synchronous inside `approve()`) - mirrors
 * `DataExportJob`'s/`MailboxImportJob`'s single-page-per-run shape. `batchSize` defaults to one request
 * per run, same reasoning as `MailboxImportJob`: each run is a potentially large, one-mailbox cascade, not
 * a routine sweep across many small rows.
 *
 * Re-checks `LegalHoldUtils.assertNotOnLegalHold()` immediately before the actual cascade (`approve()`
 * already checked it once, but a hold can be placed in the gap between that approval and this job
 * actually running) - a request found still held is skipped, not errored, and retried automatically on a
 * later run once the matter closes, the same "skip, don't error" shape `RetentionEnforcementJob`'s own
 * `Message` purge already uses.
 *
 * Every purged `Message`/`Attachment`/`Contact` also has its `BlobStore` content explicitly deleted
 * (`bodyBlobKey`/`sanitizedHtmlBlobKey`, `blobKey`/`extractedTextBlobKey`, `photoBlobKey` respectively) -
 * the ORM layer has no idea these opaque byte payloads exist, so leaving them behind after the owning row
 * is gone would defeat the entire point of a "leave no trace" feature. `BlobStore.delete()` is
 * documented as a no-op for a key that doesn't exist, so no existence check is needed first.
 *
 * Cascades across every real `mailboxUid`-scoped entity type this codebase has - not just the
 * `Message`/`Contact`/`ContactList`/`CalendarEvent`/`Task`/`Note`/`Attachment` set `DataExportJob`'s own
 * JSON bundle collects (a deliberately narrower "useful portability content" scope that doesn't apply
 * here), plus `Folder` (which that job also leaves out as "low audit value" for a portability export, but
 * an orphaned folder after its owning mailbox is gone would be a real data-hygiene gap for a feature whose
 * whole point is leaving no trace). Verified against every interface in `models/types.ts` that declares a
 * `mailboxUid` field, this also purges `FocusedInboxOverride`/`TaskList`/`Label`/`MailFilterRule`/
 * `MailSignature`/`BookingType`/`Booking`/`OofReplySuppression`/plugin `@MailboxScopedData()` models/`QuarantineEntry`/
 * `IngestQueueEntry` (each carries real personal data - sender addresses, a signature's name/contact
 * details, booking attendee details, filter-rule conditions naming other people - that would otherwise
 * silently survive an "erasure" that reports itself complete), and `DataExportRequest`/
 * `MailboxImportRequest` (each can reference a `BlobStore`-held copy of this mailbox's own content - a
 * past export bundle or an import's original source file - that must not outlive the mailbox it was taken
 * from).
 *
 * Deliberately still NOT purged: `KeyVault` (the mailbox's E2E-encryption key material - a distinct
 * subsystem with its own lifecycle/escrow interactions this job doesn't own, a scoped fast-follow rather
 * than something to touch without that subsystem's own review) and `EscrowAccessRequest`/
 * `EscrowAuditLogEntry` (this mailbox's own escrow-access audit trail, which - like `AuditLogEntry`
 * elsewhere in this codebase - must outlive the record it audits, not disappear the moment that record
 * does). `CalendarShareLink` is `folderUid`-scoped, not `mailboxUid`-scoped, so it isn't caught by this
 * job's per-mailbox-uid sweep either - purging it would need iterating the mailbox's own (already-deleted-
 * by-the-time-anyone-would-look) folder uids instead, a narrower, separate fast-follow.
 *
 * Concrete entity classes are supplied by the Mongo/SQL subclasses (`ErasureExecutionJobMongo`/
 * `ErasureExecutionJobSQL`), following the same multi-entity-type generic pattern `ScanQueueJob`/
 * `DataExportJob` use.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class ErasureExecutionJob<T extends DataSubjectErasureRequest, MB extends Mailbox> extends BackgroundService {
    protected abstract dataSubjectErasureRequestClass: any;
    protected abstract mailboxClass: any;
    protected abstract folderClass: any;
    protected abstract messageClass: any;
    protected abstract contactClass: any;
    protected abstract contactListClass: any;
    protected abstract calendarEventClass: any;
    protected abstract taskClass: any;
    protected abstract noteClass: any;
    protected abstract attachmentClass: any;
    protected abstract focusedInboxOverrideClass: any;
    protected abstract taskListClass: any;
    protected abstract labelClass: any;
    protected abstract mailFilterRuleClass: any;
    protected abstract mailSignatureClass: any;
    protected abstract bookingTypeClass: any;
    protected abstract bookingClass: any;
    protected abstract oofReplySuppressionClass: any;
    protected abstract quarantineEntryClass: any;
    protected abstract ingestQueueEntryClass: any;
    protected abstract dataExportRequestClass: any;
    protected abstract mailboxImportRequestClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so this job's own hold re-check can resolve without
     * depending on either backend directly - see `util/LegalHoldUtils.ts`. */
    protected abstract matterClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so this job can persist an `AuditLogEntry` without
     * depending on either backend directly - see `util/AuditLogUtils.ts`. */
    protected abstract auditLogClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private requestRepo?: RepoUtils<T>;
    private mailboxRepo?: RepoUtils<MB>;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    @Config("mail:jobs:erasure_execution:schedule", "*/30 * * * * *")
    private scheduleExpr: string = "*/30 * * * * *";

    // One approved mailbox per run - see this class's own doc comment for why (unlike `DataExportJob`'s 10).
    @Config("mail:jobs:erasure_execution:batch_size", 1)
    private batchSize: number = 1;

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
            name: this.dataSubjectErasureRequestClass.name,
            args: [this.dataSubjectErasureRequestClass],
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
        if (!this.requestRepo || !this.mailboxRepo || !this.blobStore) {
            return;
        }

        const approved: T[] = await this.requestRepo.find(
            { status: "approved", limit: this.batchSize } as any,
            { ignoreACL: true, limit: this.batchSize },
        );

        for (const request of approved) {
            try {
                await this.processRequest(request);
            } catch (err: any) {
                this.logger?.error(`ErasureExecutionJob: failed to process erasure request ${request.uid}: ${err.message}`);
            }
        }
    }

    private async processRequest(request: T): Promise<void> {
        try {
            await assertNotOnLegalHold(this._objectFactory!, this.matterClass, request.mailboxUid);
        } catch {
            // Still held - skip, don't error. Retried automatically on a later run once the matter closes.
            return;
        }

        const mailbox: MB | undefined = await this.mailboxRepo!.findOne(request.mailboxUid, { ignoreACL: true });

        let purgedCount = 0;
        // `blobKey`/`bodyBlobKey` are required (non-optional) fields on `Attachment`/`Message` - deleted
        // unconditionally, trusting that invariant rather than defensively re-checking it. Only the
        // genuinely optional companions (`extractedTextBlobKey`/`sanitizedHtmlBlobKey`) need a presence
        // check first.
        purgedCount += await this.purgeEntityType(this.attachmentClass, request.mailboxUid, async (row: any) => {
            await this.blobStore!.delete(row.blobKey);
            if (row.extractedTextBlobKey) {
                await this.blobStore!.delete(row.extractedTextBlobKey);
            }
        });
        purgedCount += await this.purgeEntityType(this.messageClass, request.mailboxUid, async (row: any) => {
            await this.blobStore!.delete(row.bodyBlobKey);
            if (row.sanitizedHtmlBlobKey) {
                await this.blobStore!.delete(row.sanitizedHtmlBlobKey);
            }
        });
        purgedCount += await this.purgeEntityType(this.contactClass, request.mailboxUid, async (row: any) => {
            if (row.photoBlobKey) {
                await this.blobStore!.delete(row.photoBlobKey);
            }
        });
        purgedCount += await this.purgeEntityType(this.contactListClass, request.mailboxUid);
        purgedCount += await this.purgeEntityType(this.calendarEventClass, request.mailboxUid);
        purgedCount += await this.purgeEntityType(this.taskClass, request.mailboxUid);
        purgedCount += await this.purgeEntityType(this.noteClass, request.mailboxUid);
        purgedCount += await this.purgeEntityType(this.folderClass, request.mailboxUid);
        purgedCount += await this.purgeEntityType(this.focusedInboxOverrideClass, request.mailboxUid);
        purgedCount += await this.purgeEntityType(this.taskListClass, request.mailboxUid);
        purgedCount += await this.purgeEntityType(this.labelClass, request.mailboxUid);
        purgedCount += await this.purgeEntityType(this.mailFilterRuleClass, request.mailboxUid);
        purgedCount += await this.purgeEntityType(this.mailSignatureClass, request.mailboxUid);
        purgedCount += await this.purgeEntityType(this.bookingTypeClass, request.mailboxUid);
        purgedCount += await this.purgeEntityType(this.bookingClass, request.mailboxUid);
        purgedCount += await this.purgeEntityType(this.oofReplySuppressionClass, request.mailboxUid);
        // Plugin models marked `@MailboxScopedData()` (e.g. ActiveSync device state) hold this mailbox's data too.
        for (const entityClass of this.pluginMailboxScopedClasses()) {
            purgedCount += await this.purgeEntityType(entityClass, request.mailboxUid);
        }
        // `rawBlobKey` is required (non-optional) on both `QuarantineEntry` and `IngestQueueEntry` -
        // deleted unconditionally, same reasoning as `Attachment.blobKey`/`Message.bodyBlobKey` above.
        purgedCount += await this.purgeEntityType(this.quarantineEntryClass, request.mailboxUid, async (row: any) => {
            await this.blobStore!.delete(row.rawBlobKey);
        });
        purgedCount += await this.purgeEntityType(this.ingestQueueEntryClass, request.mailboxUid, async (row: any) => {
            await this.blobStore!.delete(row.rawBlobKey);
        });
        purgedCount += await this.purgeEntityType(this.dataExportRequestClass, request.mailboxUid, async (row: any) => {
            if (row.blobKey) {
                await this.blobStore!.delete(row.blobKey);
            }
        });
        purgedCount += await this.purgeEntityType(this.mailboxImportRequestClass, request.mailboxUid, async (row: any) => {
            await this.blobStore!.delete(row.sourceBlobKey);
        });

        if (mailbox) {
            try {
                // A final re-check: the top-of-method hold check only catches a hold already in place
                // before this run started, not one placed WHILE this potentially-long cascade was already
                // running. This mailbox's own content is already gone by this point regardless (a
                // narrow, documented TOCTOU window - see this class's own doc comment), but stopping here
                // at least keeps the anchor `Mailbox` record itself in place rather than also destroying
                // the one thing a hold is meant to keep discoverable. `status` is deliberately left
                // `"approved"` (not advanced to `"completed"`) so a later run retries this exact final
                // step once the hold resolves - every entity type purged above is already empty by then,
                // so the retry is a cheap no-op cascade followed by just this one remaining check, the
                // same "skip, don't error, retry automatically" shape the top-of-method check already
                // uses.
                await assertNotOnLegalHold(this._objectFactory!, this.matterClass, request.mailboxUid);
            } catch {
                this.logger?.error(
                    `ErasureExecutionJob: a legal hold appeared on mailbox ${request.mailboxUid} while erasure request ${request.uid} was already running - ${purgedCount} rows were purged before it was detected; the mailbox record itself was preserved pending the hold's resolution.`,
                );
                return;
            }
            try {
                await this.mailboxRepo!.delete(mailbox.uid, { ignoreACL: true, purge: true });
                purgedCount++;
            } catch (err: any) {
                this.logger?.warn(`ErasureExecutionJob: failed to purge mailbox ${mailbox.uid}: ${err.message}`);
            }
        }

        await this.markCompleted(request, purgedCount);
    }

    /** Purges every `mailboxUid`-matching row of one entity type, best-effort per row (a single row's
     * failure is logged and skipped, not fatal to the rest of the cascade - the same tolerance
     * `RetentionEnforcementJob`'s own per-record purge loop already accepts). `onBeforeDelete`, when
     * given, deletes that row's own `BlobStore` content first. */
    private async purgeEntityType(entityClass: any, mailboxUid: string, onBeforeDelete?: (row: any) => Promise<void>): Promise<number> {
        const repo: RepoUtils<any> = await this.getRepo(entityClass);
        const rows: any[] = await this.findAllPages(repo, { mailboxUid });

        let purgedCount = 0;
        for (const row of rows) {
            try {
                if (onBeforeDelete) {
                    await onBeforeDelete(row);
                }
                await repo.delete(row.uid, { ignoreACL: true, purge: true });
                purgedCount++;
            } catch (err: any) {
                this.logger?.warn(`ErasureExecutionJob: failed to purge ${entityClass.name} ${row.uid}: ${err.message}`);
            }
        }
        return purgedCount;
    }

    /** Every loaded model marked `@MailboxScopedData()` that lives in the same datastore as this job's own
     * `Mailbox` model. The loader registers each class under more than one name, hence the de-duplication. */
    private pluginMailboxScopedClasses(): any[] {
        const datastore: unknown = Reflect.getMetadata("rrst:datasource", this.mailboxClass);
        const classes: Set<any> = new Set();
        for (const clazz of this._objectFactory!.classes.values()) {
            if (isMailboxScopedData(clazz) && Reflect.getMetadata("rrst:datasource", clazz) === datastore) {
                classes.add(clazz);
            }
        }
        return [...classes];
    }

    private async getRepo(entityClass: any): Promise<RepoUtils<any>> {
        return await this._objectFactory!.newInstance(RepoUtils, { name: entityClass.name, args: [entityClass] });
    }

    /** Fetches every page of `repo.find(criteria, ...)` results - see `DataExportJob.findAllPages()`'s
     * identical rationale (a bare, unpaginated `find()` silently truncates at 100 rows). An erasure must
     * be complete, not a sample. */
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

    private async markCompleted(request: T, purgedCount: number): Promise<void> {
        // Deliberately uses `request`'s own ORIGINALLY-fetched `version` (from the `find()` call at the
        // top of `run()`), never a version refetched right before this write - the same "let a stale
        // version be genuinely rejected" discipline `DataExportJob`/`MatterExportJob`'s own final `update()`
        // calls already use. A refetch-then-write here would defeat optimistic locking entirely: two
        // concurrent job instances (a real possibility in a multi-node deployment - `BackgroundService`'s
        // own overlap guard is per-process, not cross-instance) racing on the same request would each
        // refetch the OTHER's just-written row and pass its own version check trivially, silently
        // overwriting a correct `purgedCount` with a stale, incomplete one and recording a second
        // `ERASURE_REQUEST_COMPLETED` audit entry - a wrong, permanent compliance record with no error
        // raised anywhere. Using the original version instead makes the SECOND concurrent writer's own
        // `update()` genuinely fail its version check, propagating up through `run()`'s own `catch` exactly
        // like any other real processing failure.
        const updated: T = await this.requestRepo!.update(
            { uid: request.uid, version: (request as any).version, status: "completed", purgedCount } as any,
            request,
            { ignoreACL: true },
        );
        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, logger: this.logger },
            {
                action: AuditAction.ERASURE_REQUEST_COMPLETED,
                targetType: "DataSubjectErasureRequest",
                targetUid: updated.uid,
                mailboxUid: updated.mailboxUid,
                details: { purgedCount },
            },
        );
    }
}
