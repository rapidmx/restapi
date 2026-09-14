///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, ObjectFactory, RecoverableBaseEntity, RepoUtils } from "@rapidrest/service-core";
import { asEntity } from "../util/EntityUtils.js";
import { BlobStore } from "../blob/BlobStore.js";
import { BlobReferenceSource, deleteBlobsIfUnreferenced, messageBlobReferenceSources } from "../util/BlobReferenceUtils.js";
import { assertNotOnLegalHold } from "../util/LegalHoldUtils.js";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { findPagesByUid } from "../util/MailboxContentUtils.js";
import { removeFromSearchIndex } from "../util/SearchIndexUtils.js";
import type { SearchEntityType, SearchProvider } from "../search/SearchProvider.js";
import { AuditAction, DataSubjectErasureRequest, Mailbox, Plugin } from "../models/types.js";
import { isMailboxScopedData, PluginRegistry } from "../plugins/PluginRegistry.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;

/**
 * The `DataSubjectErasureRequest.status` a request has while a worker is running its cascade - set by a version-checked
 * claim (see `ErasureExecutionJob.claimRequest()`), kept alive by periodic renewals, and handed back to `"approved"`
 * when the cascade has to wait (a legal hold, an unloaded plugin, an error). Not (yet) part of the
 * `DataSubjectErasureStatus` union in `models/types.ts`; the column is a plain string on both backends.
 *
 * Anything that must not add content to a mailbox being erased (e.g. delivery) should treat only an `"in_progress"`
 * request whose claim is live (`dateModified` within `claim_lease_seconds`) as "cascade running". An `"approved"` request
 * may wait indefinitely (a legal hold, an unloaded plugin), so it can justify deferring content for a bounded time at
 * most, never dropping it; and a request created before the mailbox row it names belongs to an earlier mailbox at the
 * same address (the uid is the address). See `ScanQueueJob.erasureDisposition()`.
 */
export const ERASURE_IN_PROGRESS = "in_progress" as DataSubjectErasureRequest["status"];

/** How many times `purgeByCriteria()` re-scans an entity type to catch rows written concurrently with the cascade. */
const MAX_PURGE_PASSES = 3;

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
 * Every purged `Message`/`Attachment`/`QuarantineEntry`/`IngestQueueEntry` also has its `BlobStore` content
 * deleted - once no other row, in any mailbox, still references it (message blobs are shared between recipient
 * mailboxes and filter-rule copies; see `util/BlobReferenceUtils.ts`). A `Contact` photo, export bundle or import
 * source belongs to one row and is deleted outright. `BlobStore.delete()` is documented as a no-op for a key that
 * doesn't exist, so no existence check is needed first.
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
 * Also purged: `KeyVault` (the mailbox's E2E-encryption key material) and every `CalendarShareLink` on one of
 * the mailbox's folders (found per folder, just before that folder is purged, since share links are
 * `folderUid`-scoped). Deliberately NOT purged: `EscrowAccessRequest`/`EscrowAuditLogEntry` (this mailbox's own
 * escrow-access audit trail, which - like `AuditLogEntry` elsewhere in this codebase - must outlive the record
 * it audits, not disappear the moment that record does).
 *
 * A request is claimed before its cascade runs: a version-checked update from `"approved"` to `"in_progress"`
 * (`ERASURE_IN_PROGRESS`), so two workers (a multi-node deployment - `BackgroundService`'s overlap guard is
 * per-process) can't run the same erasure. The claim is renewed while the cascade runs and handed back to `"approved"`
 * whenever the request has to wait; one left `"in_progress"` by a dead worker is picked up again once
 * `claim_lease_seconds` passes without a renewal. Each entity type is purged in keyset-ordered, streamed batches, and
 * re-scanned to catch rows a concurrent delivery wrote behind the cursor. Messages, contacts, calendar events, tasks
 * and notes also have their search index documents removed.
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
    protected abstract keyVaultClass: any;
    protected abstract calendarShareLinkClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so this job can tell which installed plugins aren't loaded in
     * this process - see `unloadedMailboxDataPlugins()`. */
    protected abstract pluginClass: any;

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

    /** Optional: when search isn't configured, index removal is a no-op. */
    @Inject("SearchProvider")
    private searchProvider?: SearchProvider;

    /** This worker's current claim on the request it's processing - see `claimRequest()`. */
    private claim?: { request: T; renewedAt: number };

    /** How long an `"in_progress"` claim may go unrenewed before another worker treats it as abandoned. A running
     * cascade renews it every third of this. */
    @Config("mail:jobs:erasure_execution:claim_lease_seconds", 900)
    private claimLeaseSeconds: number = 900;

    /** Rows read (and deleted) per keyset page while purging one entity type. */
    @Config("mail:jobs:erasure_execution:purge_page_size", 500)
    private purgePageSize: number = 500;

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

        // Candidates: approved requests, plus in-progress ones whose claim has gone stale (the worker that claimed it
        // died mid-cascade - an active worker renews its claim well within the lease, see `renewClaimIfDue()`).
        // `limit` goes in both the query object (SQL) and `options` (Mongo); sorted so the oldest request runs first.
        const limit: number = Math.max(1, Math.min(this.batchSize, 1000));
        const staleBefore: Date = new Date(Date.now() - this.claimLeaseSeconds * 1000);
        const candidates: T[] = await this.requestRepo.find(
            {
                $or: [{ status: `eq(approved)` }, { status: `eq(${ERASURE_IN_PROGRESS})`, dateModified: `lt(${staleBefore.toISOString()})` }],
                sort: { dateCreated: "ASC", uid: "ASC" },
                limit,
            } as any,
            { ignoreACL: true, limit, skipCache: true },
        );

        for (const candidate of candidates) {
            try {
                await this.processRequest(candidate);
            } catch (err: any) {
                this.logger?.error(`ErasureExecutionJob: failed to process erasure request ${candidate.uid}: ${err.message}`);
                // Hand an unexpectedly failed request straight back rather than leaving it claimed until the lease runs out.
                await this.releaseClaim();
            } finally {
                this.claim = undefined;
            }
        }
    }

    /**
     * Claims `request` for this worker: a version-checked update of its `status` to `"in_progress"` (see
     * `ERASURE_IN_PROGRESS`). Two workers that read the same request both hold the same `version`; only one update can
     * match it, the other gets a 409 and skips the request. Returns `false` if the claim was lost.
     */
    private async claimRequest(request: T): Promise<boolean> {
        try {
            const claimed: T = await this.requestRepo!.update(
                { uid: request.uid, version: (request as any).version, status: ERASURE_IN_PROGRESS } as any,
                asEntity(this.requestRepo!, request),
                { ignoreACL: true },
            );
            this.claim = { request: claimed, renewedAt: Date.now() };
            return true;
        } catch (err: any) {
            this.logger?.debug?.(`ErasureExecutionJob: erasure request ${request.uid} was claimed by another worker: ${err.message}`);
            return false;
        }
    }

    /**
     * Renews this worker's claim (a version-checked no-op status write, which bumps `dateModified`) once a third of the
     * lease has passed, so a long cascade is never mistaken for an abandoned one. Throws if the claim was lost (another
     * worker took the request over after the lease lapsed), which stops this worker's cascade.
     */
    private async renewClaimIfDue(): Promise<void> {
        const claim = this.claim;
        if (!claim || Date.now() - claim.renewedAt < (this.claimLeaseSeconds * 1000) / 3) {
            return;
        }
        const renewed: T = await this.requestRepo!.update(
            { uid: claim.request.uid, version: (claim.request as any).version, status: ERASURE_IN_PROGRESS } as any,
            asEntity(this.requestRepo!, claim.request),
            { ignoreACL: true },
        );
        this.claim = { request: renewed, renewedAt: Date.now() };
    }

    /** Hands a claimed request back as `"approved"` so a later run retries it (a hold, an unloaded plugin, an error).
     * Best-effort: if it fails, the claim simply expires after `claim_lease_seconds`. Only ever called while this worker
     * holds a claim: every path that can fail or hand a request back (including `run()`'s catch - nothing in
     * `processRequest()` before `claimRequest()` can throw) runs after a successful `claimRequest()`. */
    private async releaseClaim(): Promise<void> {
        const claim = this.claim!;
        this.claim = undefined;
        try {
            await this.requestRepo!.update(
                { uid: claim.request.uid, version: (claim.request as any).version, status: "approved" } as any,
                asEntity(this.requestRepo!, claim.request),
                { ignoreACL: true },
            );
        } catch (err: any) {
            this.logger?.warn(`ErasureExecutionJob: failed to release erasure request ${claim.request.uid}: ${err.message}`);
        }
    }

    private async processRequest(request: T): Promise<void> {
        try {
            await assertNotOnLegalHold(this._objectFactory!, this.matterClass, request.mailboxUid);
        } catch {
            // Still held - skip, don't error. Retried automatically on a later run once the matter closes.
            if (request.status !== "approved") {
                // A stale in-progress request found held: hand it back so it reads as waiting, not running.
                if (await this.claimRequest(request)) {
                    await this.releaseClaim();
                }
            }
            return;
        }

        if (!(await this.claimRequest(request))) {
            return;
        }
        request = this.claim!.request;

        const mailbox: MB | undefined = await this.mailboxRepo!.findOne(request.mailboxUid, { ignoreACL: true });

        let purgedCount = 0;
        // Message content blobs are shared: one inbound raw blob is referenced by every recipient mailbox's
        // `Message`/`IngestQueueEntry`/`QuarantineEntry`, and attachment/sanitized-HTML blobs by a message and its
        // mail-filter copies. Each row is deleted first, then its blobs only if no other row (in any mailbox,
        // soft-deleted included) still references them - see `util/BlobReferenceUtils.ts`. Erasing one recipient
        // must never destroy another recipient's copy, least of all a legal-hold custodian's.
        const blobSources: BlobReferenceSource[] = messageBlobReferenceSources({
            messageClass: this.messageClass,
            attachmentClass: this.attachmentClass,
            quarantineEntryClass: this.quarantineEntryClass,
            ingestQueueEntryClass: this.ingestQueueEntryClass,
        });
        const deleteSharedBlobs = async (...keys: (string | undefined)[]): Promise<void> => {
            await deleteBlobsIfUnreferenced(this._objectFactory!, this.blobStore!, blobSources, keys);
        };
        purgedCount += await this.purgeEntityType(this.attachmentClass, request.mailboxUid, undefined, async (row: any) => {
            await deleteSharedBlobs(row.blobKey, row.extractedTextBlobKey);
        });
        // Every indexed entity type also has its search document removed once its row is gone - otherwise the search
        // provider keeps serving the erased subject/body/attachment text (the "message" document covers a message's
        // attachment text too). Best-effort: see `removeFromSearchIndex()`.
        const removeFromIndex =
            (entityType: SearchEntityType) =>
            async (row: any): Promise<void> => {
                await removeFromSearchIndex(this.searchProvider, entityType, row.uid, this.logger);
            };
        purgedCount += await this.purgeEntityType(this.messageClass, request.mailboxUid, undefined, async (row: any) => {
            await removeFromIndex("message")(row);
            await deleteSharedBlobs(row.bodyBlobKey, row.sanitizedHtmlBlobKey);
        });
        purgedCount += await this.purgeEntityType(
            this.contactClass,
            request.mailboxUid,
            async (row: any) => {
                if (row.photoBlobKey) {
                    await this.blobStore!.delete(row.photoBlobKey);
                }
            },
            removeFromIndex("contact"),
        );
        purgedCount += await this.purgeEntityType(this.contactListClass, request.mailboxUid);
        purgedCount += await this.purgeEntityType(this.calendarEventClass, request.mailboxUid, undefined, removeFromIndex("calendarEvent"));
        purgedCount += await this.purgeEntityType(this.taskClass, request.mailboxUid, undefined, removeFromIndex("task"));
        purgedCount += await this.purgeEntityType(this.noteClass, request.mailboxUid, undefined, removeFromIndex("note"));
        // `CalendarShareLink` is scoped by `folderUid`, not `mailboxUid`, so its rows are found through each folder
        // before that folder is purged (purging the folder also removes the folder ACL holding the link's token).
        let shareLinkCount = 0;
        purgedCount += await this.purgeEntityType(this.folderClass, request.mailboxUid, async (row: any) => {
            shareLinkCount += await this.purgeByCriteria(this.calendarShareLinkClass, { folderUid: row.uid });
        });
        purgedCount += shareLinkCount;
        purgedCount += await this.purgeEntityType(this.focusedInboxOverrideClass, request.mailboxUid);
        purgedCount += await this.purgeEntityType(this.taskListClass, request.mailboxUid);
        purgedCount += await this.purgeEntityType(this.labelClass, request.mailboxUid);
        purgedCount += await this.purgeEntityType(this.mailFilterRuleClass, request.mailboxUid);
        purgedCount += await this.purgeEntityType(this.mailSignatureClass, request.mailboxUid);
        purgedCount += await this.purgeEntityType(this.bookingTypeClass, request.mailboxUid);
        purgedCount += await this.purgeEntityType(this.bookingClass, request.mailboxUid);
        purgedCount += await this.purgeEntityType(this.oofReplySuppressionClass, request.mailboxUid);
        // The mailbox's end-to-end encryption key material (wrapped private keys and master-key wraps).
        purgedCount += await this.purgeEntityType(this.keyVaultClass, request.mailboxUid);
        // Plugin models marked `@MailboxScopedData()` (e.g. ActiveSync device state) hold this mailbox's data too.
        for (const entityClass of this.pluginMailboxScopedClasses()) {
            purgedCount += await this.purgeEntityType(entityClass, request.mailboxUid);
        }
        purgedCount += await this.purgeEntityType(this.quarantineEntryClass, request.mailboxUid, undefined, async (row: any) => {
            await deleteSharedBlobs(row.rawBlobKey);
        });
        purgedCount += await this.purgeEntityType(this.ingestQueueEntryClass, request.mailboxUid, undefined, async (row: any) => {
            await deleteSharedBlobs(row.rawBlobKey);
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
                // the one thing a hold is meant to keep discoverable. `status` is deliberately handed back as
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
                await this.releaseClaim();
                return;
            }
            try {
                await this.mailboxRepo!.delete(mailbox.uid, { ignoreACL: true, purge: true });
                purgedCount++;
            } catch (err: any) {
                this.logger?.warn(`ErasureExecutionJob: failed to purge mailbox ${mailbox.uid}: ${err.message}`);
            }
        }

        // A plugin whose manifest declares `mailboxScopedData` but isn't loaded here (disabled, failed to load, safe
        // mode) registered no `@MailboxScopedData()` models, so its rows for this mailbox were never seen above.
        // Completing now would report an erasure that left them behind. Instead `status` stays `"approved"` - the same
        // retry shape as the hold check above - and a later run, once the plugin is loaded again, purges them and
        // completes. The request has no field for the reason, so it's logged. A plugin that doesn't declare mailbox data
        // never holds an erasure.
        const { unloaded, removed } = await this.unloadedMailboxDataPlugins();
        if (unloaded.length > 0) {
            this.logger?.error(
                `ErasureExecutionJob: erasure request ${request.uid} is waiting for plugins that store mailbox data but aren't loaded (${unloaded.join(", ")}) - their data for mailbox ${request.mailboxUid} can't be purged until they are. Enable them or fix their loading; the request is retried on a later run.`,
            );
            await this.releaseClaim();
            return;
        }
        if (removed.length > 0) {
            // A removed plugin will never be loaded again to purge its rows, so holding would block the erasure forever.
            // It completes, but what it couldn't reach is recorded (the request has no field for it).
            this.logger?.error(
                `ErasureExecutionJob: erasure request ${request.uid} completed without erasing mailbox ${request.mailboxUid}'s data stored by removed plugins (${removed.join(", ")}). Remove that data manually.`,
            );
        }

        // The claim's own latest version (renewals included), so a worker that lost its claim can't complete the request.
        await this.markCompleted(this.claim!.request, purgedCount);
        this.claim = undefined;
    }

    /** The plugins declaring `mailboxScopedData` in their stored manifest that aren't loaded in this process, per
     * `PluginRegistry`: installed ones (`unloaded`) and removed ones (`removed`). */
    private async unloadedMailboxDataPlugins(): Promise<{ unloaded: string[]; removed: string[] }> {
        const rows: Plugin[] = [];
        for await (const batch of findPagesByUid<Plugin>(await this.getRepo(this.pluginClass), {})) {
            rows.push(...batch);
        }
        const candidates: Plugin[] = rows.filter((row) => row.manifest.mailboxScopedData === true && !PluginRegistry.isActive(row.name));
        const names = (removed: boolean): string[] =>
            candidates
                .filter((row) => !!row.removed === removed)
                .map((row) => row.name)
                .sort();
        return { unloaded: names(false), removed: names(true) };
    }

    /** Purges every `mailboxUid`-matching row of one entity type - see `purgeByCriteria()`. */
    private async purgeEntityType(
        entityClass: any,
        mailboxUid: string,
        onBeforeDelete?: (row: any) => Promise<void>,
        onAfterDelete?: (row: any) => Promise<void>,
    ): Promise<number> {
        return await this.purgeByCriteria(entityClass, { mailboxUid }, onBeforeDelete, onAfterDelete);
    }

    /** Purges every row of one entity type matching `criteria`, best-effort per row (a single row's failure is
     * logged and skipped, not fatal to the rest of the cascade - the same tolerance `RetentionEnforcementJob`'s
     * own per-record purge loop already accepts). `onBeforeDelete`, when given, runs first (a row's own unshared
     * `BlobStore` content, or its dependent rows); `onAfterDelete` runs once the row is gone (shared blobs that no
     * remaining row references). */
    private async purgeByCriteria(
        entityClass: any,
        criteria: Record<string, any>,
        onBeforeDelete?: (row: any) => Promise<void>,
        onAfterDelete?: (row: any) => Promise<void>,
    ): Promise<number> {
        const repo: RepoUtils<any> = await this.getRepo(entityClass);
        // A soft-deleted row of a recoverable entity (e.g. a message in Deleted Items) is still this mailbox's data,
        // but `find()` excludes it unless `deleted: true` is asked for explicitly.
        const criteriaSets: Record<string, any>[] =
            new entityClass() instanceof RecoverableBaseEntity ? [criteria, { ...criteria, deleted: true }] : [criteria];

        // Rows are streamed in keyset-ordered batches (`findPagesByUid()`) and deleted as each batch arrives, never
        // loaded all at once. A single pass can still miss a row written concurrently behind its cursor (e.g. a
        // delivery that raced this erasure), so passes repeat until one purges nothing, bounded by `MAX_PURGE_PASSES`.
        // A row that failed this run is not retried by a later pass (it's counted as seen), so a persistently failing
        // row ends the loop instead of spinning it.
        const failed: Set<string> = new Set();
        let purgedCount = 0;
        for (let pass = 0; pass < MAX_PURGE_PASSES; pass++) {
            let purgedThisPass = 0;
            for (const passCriteria of criteriaSets) {
                for await (const batch of findPagesByUid(repo, passCriteria, this.purgePageSize)) {
                    await this.renewClaimIfDue();
                    for (const row of batch) {
                        if (failed.has(row.uid)) {
                            continue;
                        }
                        try {
                            if (onBeforeDelete) {
                                await onBeforeDelete(row);
                            }
                            await repo.delete(row.uid, { ignoreACL: true, purge: true });
                            purgedCount++;
                            purgedThisPass++;
                            if (onAfterDelete) {
                                await onAfterDelete(row);
                            }
                        } catch (err: any) {
                            failed.add(row.uid);
                            this.logger?.warn(`ErasureExecutionJob: failed to purge ${entityClass.name} ${row.uid}: ${err.message}`);
                        }
                    }
                }
            }
            if (purgedThisPass === 0) {
                break;
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


    private async markCompleted(request: T, purgedCount: number): Promise<void> {
        // Deliberately uses `request`'s own `version` as this worker last wrote it (its claim, or latest claim
        // renewal), never a version refetched right before this write - the same "let a stale
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
            asEntity(this.requestRepo!, request),
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
