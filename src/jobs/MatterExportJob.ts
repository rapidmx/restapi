///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { BlobStore } from "../blob/BlobStore.js";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { recordEscrowAuditEntry } from "../util/EscrowAuditUtils.js";
import { collectMailboxContentLines, DEFAULT_MAX_MAILBOX_CONTENT_ROWS, MailboxContentEntityClasses } from "../util/MailboxContentUtils.js";
import { AuditAction, EscrowAuditAction, Mailbox, Matter, MatterExportRequest } from "../models/types.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;

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
    // whole-request total).
    @Config("mail:jobs:matter_export:max_content_rows", DEFAULT_MAX_MAILBOX_CONTENT_ROWS)
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

        const dateRange = { start: matter.dateRangeStart, end: matter.dateRangeEnd };
        const allLines: string[] = [];
        // Collected here and only actually recorded (below) once the export bundle as a whole has been
        // successfully written and the request marked "ready" - see this class's own doc comment. Each
        // `EscrowAuditLogEntry` is a permanent, hash-chained attestation that a specific mailbox's content
        // was included in a completed, downloadable export; recording it any earlier (e.g. immediately
        // after that one mailbox's own content was collected) would let a LATER custodian's failure - a
        // `collectMailboxContentLines()` row-cap overrun, a transient DB/blob error - mark the whole
        // request "failed" while leaving behind a permanent, unfixable record falsely attesting that an
        // export completed for the mailboxes already processed.
        const includedMailboxUids: string[] = [];
        for (const mailboxUid of matter.custodianMailboxUids) {
            const mailbox: MB | undefined = await this.mailboxRepo!.findOne(mailboxUid, { ignoreACL: true });
            if (!mailbox) {
                this.logger?.warn(`MatterExportJob: skipping custodian mailbox ${mailboxUid} for request ${request.uid} - it no longer exists.`);
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
                    `MatterExportJob: skipping custodian mailbox ${mailboxUid} for request ${request.uid} - it is not actually assigned to this matter's escrow scope.`,
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
            allLines.push(...lines);
            includedMailboxUids.push(mailboxUid);
        }

        const blobKey = `matter-exports/${request.uid}.ndjson`;
        await this.blobStore!.put(blobKey, Buffer.from(allLines.join("\n"), "utf-8"), { contentType: "application/x-ndjson" });

        await this.requestRepo!.update(
            { uid: request.uid, version: (request as any).version, status: "ready", blobKey } as any,
            request,
            { ignoreACL: true },
        );

        for (const mailboxUid of includedMailboxUids) {
            await recordEscrowAuditEntry(this._objectFactory!, this.escrowAuditLogClass, {
                action: EscrowAuditAction.MATTER_EXPORT_READY,
                holderUserUid: request.requestedByUserUid,
                matterId: matter.uid,
                mailboxUid,
                requestId: request.uid,
            });
        }
    }

    private async markFailed(request: T, errorMessage: string): Promise<void> {
        try {
            const updated: T = await this.requestRepo!.update(
                { uid: request.uid, version: (request as any).version, status: "failed", errorMessage } as any,
                request,
                { ignoreACL: true },
            );
            await recordAuditLog(
                this._objectFactory!,
                this.auditLogClass,
                { config: this.config, logger: this.logger },
                { action: AuditAction.MATTER_EXPORT_FAILED, targetType: "MatterExportRequest", targetUid: updated.uid },
            );
        } catch (err: any) {
            this.logger?.error(`MatterExportJob: failed to mark export request ${request.uid} as failed: ${err.message}`);
        }
    }
}
