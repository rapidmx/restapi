///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, BaseEntity, ModelUtils, ObjectFactory, RepoUtils, SimpleEntity } from "@rapidrest/service-core";
import { asEntity } from "../util/EntityUtils.js";
import { findPagesByUid } from "../util/MailboxContentUtils.js";
import { BlobStore } from "../blob/BlobStore.js";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
import { Attachment, Mailbox, Message } from "../models/types.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;

/** How many message uids `recalcMailbox()` batches into a single `messageUid: in(...)` attachment query at
 * once - small enough to keep the generated query comfortably within the shared query DSL's own node/length
 * limits, large enough to meaningfully cut the number of round-trips versus one query per message. */
const ATTACHMENT_QUERY_CHUNK_SIZE = 100;

/** How many message body sizes (one blob store call each - an S3 HEAD) `recalcMailbox()` asks for at once. */
const BODY_SIZE_CONCURRENCY = 16;

/**
 * Periodically recomputes `Mailbox.usedBytes` from the mailbox's actual stored content (message body blobs plus
 * attachment content) and corrects any drift from the incremental updates other code paths (ingest, delete,
 * etc.) are expected to apply on their own. This job is a safety net against drift, not the primary mechanism
 * for keeping `usedBytes` accurate — it runs cheaply and idempotently, and only writes when the recomputed value
 * actually differs from what's stored.
 *
 * Concrete entity classes are supplied by the Mongo/SQL subclasses (`MailboxQuotaRecalcJobMongo`/
 * `MailboxQuotaRecalcJobSQL`), following the same multi-entity-type generic pattern `ScanQueueJob` uses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class MailboxQuotaRecalcJob<MB extends Mailbox, M extends Message, A extends Attachment> extends BackgroundService {
    protected abstract mailboxClass: any;
    protected abstract messageClass: any;
    protected abstract attachmentClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private mailboxRepo?: RepoUtils<MB>;
    private messageRepo?: RecoverableRepoUtils<M>;
    private attachmentRepo?: RepoUtils<A>;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    @Config("mail:jobs:mailbox_quota_recalc:schedule", "0 0 * * * *")
    private scheduleExpr: string = "0 0 * * * *";

    @Config("mail:jobs:mailbox_quota_recalc:batch_size", 100)
    private batchSize: number = 100;

    /** Messages read per keyset page while summing one mailbox. */
    private messagePageSize: number = 500;

    @Logger
    private logger: any;

    public get schedule(): string | undefined {
        return this.scheduleExpr;
    }

    @Init
    public async init(): Promise<void> {
        this.mailboxRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.mailboxClass.name,
            args: [this.mailboxClass],
        });
        this.messageRepo = await this._objectFactory!.newInstance(RecoverableRepoUtils, {
            name: this.messageClass.name,
            args: [this.messageClass],
        });
        this.attachmentRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.attachmentClass.name,
            args: [this.attachmentClass],
        });
    }

    public async start(): Promise<void> {
        // Nothing to do at startup beyond `init()` above; processing happens entirely in `run()`.
    }

    public stop(): Promise<void> | void {
        // Do nothing
    }

    public async run(): Promise<void> {
        if (!this.mailboxRepo || !this.messageRepo || !this.attachmentRepo || !this.blobStore) {
            return;
        }

        // Pages through every mailbox, `batchSize` at a time, sorted by `uid` so page boundaries are stable -
        // previously only the first page was ever processed, so any mailbox past the first `batchSize` (sorted
        // arbitrarily) never had its drift corrected at all.
        //
        // `limit`/`page` are passed both via `options` (which is all the Mongo backend of `RepoUtils.find()`
        // actually reads) *and* baked into the query object itself (which is all `ModelUtils.buildSearchQuerySQL`
        // reads - it ignores `options.limit` entirely and falls back to its own default of 100 otherwise).
        // Confirmed by real-database testing: on the SQL backend, `options.limit` alone silently caps at 100
        // regardless of the configured batch size, rather than the requested value.
        for (let page = 0; ; page++) {
            const mailboxes: MB[] = await this.mailboxRepo.find(
                { sort: "uid", limit: this.batchSize, page } as any,
                { ignoreACL: true, limit: this.batchSize, page },
            );

            for (const mailbox of mailboxes) {
                try {
                    await this.recalcMailbox(mailbox);
                } catch (err: any) {
                    this.logger?.error(
                        `MailboxQuotaRecalcJob: failed to recalculate usedBytes for mailbox ${mailbox.uid}: ${err.message}`,
                    );
                }
            }
            if (mailboxes.length < this.batchSize) {
                break;
            }
        }
    }

    /**
     * Fetches every page of `repo.find(criteria, ...)` results, not just the first. `RepoUtils.find()` caps at
     * 100 rows per call by default (and SQL ignores `options.limit`/`options.page` entirely unless `limit`/
     * `page` are *also* baked into the criteria object itself - see the comments on `run()`'s own `find()` call
     * above for the full explanation) - a bare, unpaginated `find()` call here would silently recompute
     * `usedBytes` from only the first ~100 messages/attachments, permanently understating usage for any mailbox
     * larger than that. Confirmed as a real bug (not just a SQL-only quirk) by real-database testing: the
     * previous unpaginated call truncated identically on both backends, since 100 is `RepoUtils.find()`'s own
     * unconditional default, independent of which backend is in use.
     */
    private async findAllPages<T extends BaseEntity | SimpleEntity>(
        repo: RepoUtils<T>,
        criteria: Record<string, any>,
        pageSize: number = 500,
    ): Promise<T[]> {
        const all: T[] = [];
        for (let page = 0; ; page++) {
            const batch: T[] = await repo.find(
                { ...criteria, limit: pageSize, page } as any,
                { ignoreACL: true, limit: pageSize, page },
            );
            all.push(...batch);
            if (batch.length < pageSize) {
                break;
            }
        }
        return all;
    }

    private async recalcMailbox(mailbox: MB): Promise<void> {
        // The state this scan starts from. A delivery or delete charges `usedBytes` while the scan runs, so what it computes from
        // rows read earlier may already be stale: the figure is applied as a correction (what the scan found minus what it started
        // from) on top of whatever the mailbox holds when the scan ends, never as an absolute value that would drop those charges.
        const start: MB = (await this.mailboxRepo!.findOne(mailbox.uid, { ignoreACL: true, skipCache: true })) ?? mailbox;

        // Messages are read in keyset pages and only what is needed is kept (their uids, to find attachments), never the whole mailbox's
        // documents at once. Their body sizes are a blob store call each, a few at a time. A soft-deleted message (Deleted Items, still
        // restorable) is a plain `find()` blind spot but its blobs are still stored, so a second pass counts those too - otherwise
        // deleting mail would hand its bytes back to the quota while they are still on disk.
        let usedBytes = 0;
        let unsized = 0;
        const messageUidsWithAttachments: string[] = [];
        for (const softDeleted of [false, true]) {
            const criteria: Record<string, any> = { mailboxUid: ModelUtils.literal(mailbox.uid), ...(softDeleted ? { deleted: true } : {}) };
            for await (const page of findPagesByUid<M>(this.messageRepo!, criteria, this.messagePageSize)) {
                for (let i = 0; i < page.length; i += BODY_SIZE_CONCURRENCY) {
                    const sizes: (number | undefined)[] = await Promise.all(page.slice(i, i + BODY_SIZE_CONCURRENCY).map((message) => this.bodySize(message)));
                    for (const size of sizes) {
                        if (size === undefined) {
                            unsized++;
                        } else {
                            usedBytes += size;
                        }
                    }
                }
                messageUidsWithAttachments.push(...page.filter((m) => m.hasAttachments).map((m) => m.uid));
            }
        }

        // Batched by messageUid via the query DSL's `in(...)` operator, `ATTACHMENT_QUERY_CHUNK_SIZE` message
        // uids at a time, instead of one `findAllPages()` call per individual message - a mailbox with
        // thousands of messages carrying attachments previously issued that many separate DB round-trips
        // every run. `sizeBytes` is summed directly across the whole mailbox's attachments; nothing here needs
        // them correlated back to a specific message.
        for (let i = 0; i < messageUidsWithAttachments.length; i += ATTACHMENT_QUERY_CHUNK_SIZE) {
            const chunk: string[] = messageUidsWithAttachments.slice(i, i + ATTACHMENT_QUERY_CHUNK_SIZE);
            const attachments: A[] = await this.findAllPages(this.attachmentRepo!, { messageUid: `in(${chunk.join(",")})` });
            for (const attachment of attachments) {
                usedBytes += attachment.sizeBytes;
            }
        }

        const startBytes: number = start.usedBytes ?? 0;
        if (unsized > 0) {
            // A blob store that is failing (an outage, an expired credential) sizes nothing, which would write a near-zero figure and
            // leave every mailbox unmetered for the next hour. What was sized is only a lower bound of the real usage: it can still
            // raise the stored figure, never lower it.
            this.logger?.warn(`MailboxQuotaRecalcJob: ${unsized} body blob(s) of mailbox ${mailbox.uid} could not be sized, so its usedBytes is only ever raised this run.`);
            if (usedBytes <= startBytes) {
                return;
            }
        }

        // Skip the write entirely when nothing has drifted - this job runs frequently and most mailboxes won't
        // have drifted, so avoiding a no-op update() call (and the version bump/push it would trigger) matters.
        if (usedBytes === startBytes) {
            return;
        }
        // `current` is a `findOne()` result, a real model instance - unlike `mailbox`, from `run()`'s own `find()`, which on
        // the Mongo backend is a plain, un-hydrated document. `RepoUtils.update()` branches its optimistic-lock check,
        // version bump, and `dateModified` refresh entirely on an `instanceof BaseEntity` check, and silently skips all
        // three (a confirmed real cross-backend bug, caught by real-database testing) when that check comes back false.
        const current: MB | undefined = await this.mailboxRepo!.findOne(mailbox.uid, { ignoreACL: true, skipCache: true });
        if (!current) {
            return;
        }
        // Anything that changed the mailbox since the scan began (a charge, a refund, an unrelated edit) has bumped its version. A
        // mailbox that is busy enough to move on every scan would never be corrected by an all-or-nothing write, so the drift the
        // scan found is applied to what it holds now. A charge that was also scanned is then counted twice until the next run
        // corrects it - the over-count is the safe direction for enforcement.
        const moved: boolean = (current as any).version !== (start as any).version;
        const target: number = moved ? Math.max(0, (current.usedBytes ?? 0) + usedBytes - startBytes) : usedBytes;
        if (target === current.usedBytes) {
            return;
        }
        try {
            await this.mailboxRepo!.update(
                { uid: current.uid, version: (current as any).version, usedBytes: target } as any,
                asEntity(this.mailboxRepo!, current),
                { ignoreACL: true, skipPush: true },
            );
        } catch (err: any) {
            // Lost a race with a charge landing right now: the next run corrects it.
            this.logger?.debug?.(`MailboxQuotaRecalcJob: mailbox ${mailbox.uid} changed while it was being corrected - left for the next run: ${err.message}`);
        }
    }

    /** One message's stored body size, `undefined` (logged) when the blob store can't say - see `recalcMailbox()`. */
    private async bodySize(message: M): Promise<number | undefined> {
        try {
            return await this.blobStore!.size(message.bodyBlobKey);
        } catch (err: any) {
            this.logger?.warn(`MailboxQuotaRecalcJob: failed to size body blob ${message.bodyBlobKey} for message ${message.uid}: ${err.message}`);
            return undefined;
        }
    }
}
