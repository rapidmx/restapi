///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { asEntity } from "../util/EntityUtils.js";
import { BlobStore } from "../blob/BlobStore.js";
import { ExtractorRegistry } from "../search/extraction/ExtractorRegistry.js";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
import { Attachment, Message } from "../models/types.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;

/** The longest error message persisted onto `Attachment.extractionError`. */
const MAX_ERROR_LENGTH = 1000;

/** How many times a message's re-index invalidation is retried on a version conflict. */
const MAX_INVALIDATE_ATTEMPTS = 3;

/**
 * Runs `ExtractorRegistry` (PDF/DOCX/plain-text/HTML text extraction) over `Attachment` records that haven't
 * been processed yet (`extractedTextBlobKey` unset), as a background job — never inline on ingestion, since
 * extraction can be slow and must not block SMTP-ACK or webmail send/save-draft latency (see the architecture
 * plan's rationale for this).
 *
 * Every eligible attachment gets `extractedTextBlobKey` set exactly once, even when nothing extractable was
 * found (an empty-content blob) — this is what marks an attachment as "already attempted" so an unsupported
 * MIME type (e.g. an image) isn't re-selected by this job forever. When extraction *does* produce non-empty
 * text for an attachment whose parent `Message` was already search-indexed, this job clears that message's
 * `searchIndexedAt` back to `undefined` so `SearchIndexJob` re-indexes it with the newly available text (see
 * `invalidateSearchIndex()` for how the race with an in-flight `SearchIndexJob` run is closed).
 *
 * An attachment whose processing throws (e.g. a transient blob-store failure, or a malformed file that crashes
 * its extractor every time) is retried with exponential backoff (`extractionAttempts`/`extractionNextAttemptAt`,
 * base delay `mail:jobs:attachment_extraction:retry_backoff_seconds`) up to
 * `mail:jobs:attachment_extraction:max_attempts` times, then left unextracted with `extractionError` recorded -
 * excluded from every later candidate query, so it can never occupy the head of the queue forever.
 *
 * An attachment of a message stored zero-access sealed (a sealed draft's upload) is neither extracted nor stamped, only put off
 * (`deferWhileSealed()`), so it is extracted once its message is readable outside zero-access. A put-off or failed attachment is only
 * selected with what attachments never looked at leave of a batch (`run()`), so however many keep coming back, new ones are still reached.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class AttachmentExtractionJob<A extends Attachment, M extends Message> extends BackgroundService {
    protected abstract attachmentClass: any;
    protected abstract messageClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    protected attachmentRepo?: RepoUtils<A>;
    protected messageRepo?: RecoverableRepoUtils<M>;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    /** Injected (never built with `new`) so the registry's `mail:search:extraction:*` limits and logger are populated, and so the
     * ObjectFactory disposes its worker thread on shutdown. */
    @Inject(ExtractorRegistry)
    protected extractorRegistry?: ExtractorRegistry;

    @Config("mail:jobs:attachment_extraction:schedule", "*/20 * * * * *")
    private scheduleExpr: string = "*/20 * * * * *";

    @Config("mail:jobs:attachment_extraction:batch_size", 25)
    private batchSize: number = 25;

    @Config("mail:jobs:attachment_extraction:max_attempts", 5)
    private maxAttempts: number = 5;

    @Config("mail:jobs:attachment_extraction:retry_backoff_seconds", 60)
    private retryBackoffSeconds: number = 60;

    /** How long an attachment of a message stored zero-access sealed waits before it is looked at again - see `deferWhileSealed()`. */
    @Config("mail:jobs:attachment_extraction:zero_access_defer_seconds", 600)
    private zeroAccessDeferSeconds: number = 600;

    /** The longest an attachment of a message stored zero-access sealed is put off at a time - see `deferWhileSealed()`. */
    @Config("mail:jobs:attachment_extraction:zero_access_defer_max_seconds", 86_400)
    private zeroAccessDeferMaxSeconds: number = 86_400;

    /** The same ceiling `ExtractorRegistry` applies to an attachment's size: one declared larger is never downloaded just to be refused. */
    @Config("mail:search:extraction:max_bytes", 25 * 1024 * 1024)
    private maxExtractBytes: number = 25 * 1024 * 1024;

    @Logger
    private logger: any;

    public get schedule(): string | undefined {
        return this.scheduleExpr;
    }

    @Init
    public async init(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        if (!this.attachmentRepo && this.attachmentClass) {
            this.attachmentRepo = await this._objectFactory.newInstance(RepoUtils, {
                name: this.attachmentClass.name,
                args: [this.attachmentClass],
            });
        }
        if (!this.messageRepo && this.messageClass) {
            this.messageRepo = await this._objectFactory.newInstance(RecoverableRepoUtils, {
                name: this.messageClass.name,
                args: [this.messageClass],
            });
        }
    }

    public async start(): Promise<void> {
        // Nothing to do at startup beyond `init()` above; processing happens entirely in `run()`.
    }

    public stop(): Promise<void> | void {
        // Do nothing
    }

    public async run(): Promise<void> {
        if (!this.attachmentRepo || !this.blobStore) {
            return;
        }

        // `limit` must be passed both via `options` (used by the Mongo backend) *and* baked into the query
        // object itself (all `ModelUtils.buildSearchQuerySQL` reads - it ignores `options.limit` entirely and
        // falls back to its own default of 100 otherwise). Confirmed by real-database testing: on the SQL
        // backend, `options.limit` alone silently caps at 100 regardless of the configured batch size.
        //
        // Candidates are an attachment never looked at, then - with what that leaves of the batch - one that has failed fewer than
        // `maxAttempts` times or was put off while sealed (`deferWhileSealed()`) and whose backoff has elapsed; one at `maxAttempts` is
        // excluded outright. Fresh ones first, so that rows coming back again and again (a sealed draft's attachments, every
        // `zero_access_defer_seconds` for as long as the draft lives, usually the oldest rows there are) only ever take the capacity new
        // attachments leave - sorted together by age, enough of them would fill every batch and no new attachment would be reached.
        // Each tier is sorted oldest-first (with `uid` as a tiebreaker) so batches are drawn in a stable order.
        const now: Date = new Date();
        const fresh: A[] = await this.attachmentRepo.find(
            { extractedTextBlobKey: null, extractionAttempts: "null", sort: { dateCreated: "ASC", uid: "ASC" }, limit: this.batchSize } as any,
            { ignoreACL: true, limit: this.batchSize },
        );
        const room: number = this.batchSize - fresh.length;
        const due: A[] =
            room > 0
                ? await this.attachmentRepo.find(
                      {
                          extractedTextBlobKey: null,
                          extractionAttempts: `lt(${this.maxAttempts})`,
                          extractionNextAttemptAt: `lte(${now.toISOString()})`,
                          sort: { dateCreated: "ASC", uid: "ASC" },
                          limit: room,
                      } as any,
                      { ignoreACL: true, limit: room },
                  )
                : [];
        const pending: A[] = [...fresh, ...due];

        for (const attachment of pending) {
            try {
                await this.processAttachment(attachment);
            } catch (err: any) {
                await this.recordFailure(attachment, err?.message ?? String(err));
            }
        }
    }

    /**
     * Records one failed processing attempt on `attachment`: increments `extractionAttempts`, schedules the next
     * attempt with exponential backoff, and stores the error. Once `maxAttempts` is reached the attachment is no
     * longer selected by `run()` and the failure is logged as an error.
     */
    private async recordFailure(attachment: A, reason: string): Promise<void> {
        const attempts: number = (attachment.extractionAttempts ?? 0) + 1;
        const exhausted: boolean = attempts >= this.maxAttempts;
        const delayMs: number = this.retryBackoffSeconds * 1000 * Math.pow(2, attempts - 1);
        if (exhausted) {
            this.logger?.error(
                `AttachmentExtractionJob: giving up on attachment ${attachment.uid} after ${attempts} failed attempt(s): ${reason}`,
            );
        } else {
            this.logger?.warn(`AttachmentExtractionJob: attempt ${attempts} to process attachment ${attachment.uid} failed: ${reason}`);
        }
        try {
            await this.attachmentRepo!.update(
                {
                    uid: attachment.uid,
                    version: (attachment as any).version,
                    extractionAttempts: attempts,
                    extractionNextAttemptAt: exhausted ? null : new Date(Date.now() + delayMs),
                    extractionError: reason.slice(0, MAX_ERROR_LENGTH),
                } as any,
                asEntity(this.attachmentRepo!, attachment),
                { ignoreACL: true },
            );
        } catch (err: any) {
            this.logger?.warn(
                `AttachmentExtractionJob: failed to record extraction failure on attachment ${attachment.uid}: ${err?.message}`,
            );
        }
    }

    private async processAttachment(attachment: A): Promise<void> {
        // `includeDeleted: true`: `RecoverableRepoUtils.findOne()` filters out a soft-deleted `Message` by
        // default, and this job's own schedule (`mail:jobs:attachment_extraction:schedule`, every ~20s by
        // default) means a message can easily be trashed between being received and this job next running.
        // Without this, `message` comes back `undefined` for a trashed message and the encryption check below
        // - reasonably reading that as "message not found, nothing to skip" - would fail OPEN and hand a
        // still-encrypted attachment's ciphertext to `ExtractorRegistry`, exactly what this method exists to
        // prevent.
        const message: M | undefined = await this.messageRepo!.findOne(attachment.messageUid, {
            ignoreACL: true,
            includeDeleted: true,
        });

        // An attachment belonging to an S/MIME-encrypted message is ciphertext to this server (a real
        // `EnvelopedData` message has no separately-visible attachment at all - see `util/SmimeUtils.ts`'s
        // doc comment - but the message could also legitimately have real attachments once decrypted
        // client-side, which this server must never attempt to read). Skipped exactly like an unsupported
        // MIME type today: `extractedTextBlobKey` is still stamped (empty) so this attachment is never
        // re-selected by this job forever, without ever handing ciphertext to `ExtractorRegistry`. An
        // unresolvable message (`undefined` even with `includeDeleted: true` - e.g. hard-deleted, or a
        // dangling reference) fails CLOSED (treated as encrypted, i.e. skipped) rather than open - but a
        // *found* message with a falsy `encrypted` (`false`, or `null`/`undefined` for a legacy row that
        // predates this column entirely - see `MessageSQL.encrypted`'s own doc comment on why that can
        // happen) is still extracted exactly as before: a pre-existing message from before this feature
        // existed is not encrypted, and failing closed for it too would silently stop indexing every
        // installation's entire attachment history, not just close the soft-delete race this change targets.
        //
        // The MIME type is matched by its bare, lower-cased `type/subtype`: a stored `Content-Type` can carry parameters
        // (`application/pdf; name=a.pdf`) or odd casing, which the registry's exact-match lookup would never find. An attachment
        // whose declared size already exceeds what the registry would take is not downloaded at all.
        //
        // An attachment of a message stored zero-access sealed - a sealed draft's upload, readable until the draft is sent - is not
        // extracted: its text would be one more readable copy of a zero-access mailbox's content, which nothing indexes (`SearchIndexJob`
        // indexes such a message as metadata only), and the sealed copy the send files carries the attachment itself. Nor is it stamped
        // (`deferWhileSealed()`): a draft saved readable once zero-access is no longer active is sent with these same rows.
        if (message && !message.encrypted && (message as any).zeroAccess) {
            await this.deferWhileSealed(attachment);
            return;
        }
        const mimeType: string = (attachment.mimeType ?? "").split(";")[0].trim().toLowerCase();
        const text: string | undefined =
            !message ||
            message.encrypted ||
            (attachment.sizeBytes ?? 0) > this.maxExtractBytes ||
            !this.extractorRegistry!.supports(mimeType)
                ? undefined
                : await this.extractorRegistry!.extract(mimeType, await this.blobStore!.get(attachment.blobKey));
        if (text !== undefined && (await this.sealedSince(attachment))) {
            // Sealed while it was extracted (the backfill sealing a draft): its text is not stored. The backfill's clean-up
            // (`ZeroAccessWriter.discardDraftPlaintext()`) also bumps the row's version, so a stamp that got past this check loses.
            await this.deferWhileSealed(attachment);
            return;
        }

        const extractedTextBlobKey = `attachment-text/${crypto.randomUUID()}`;
        await this.blobStore!.put(extractedTextBlobKey, Buffer.from(text ?? "", "utf-8"), {
            contentType: "text/plain",
        });

        const attachmentUpdate: any = { uid: attachment.uid, version: (attachment as any).version, extractedTextBlobKey };
        if (
            (attachment.extractionAttempts ?? null) !== null ||
            (attachment.extractionNextAttemptAt ?? null) !== null ||
            (attachment.extractionError ?? null) !== null
        ) {
            // A retry that finally succeeded - clear the failure bookkeeping (explicit `null` for SQL).
            attachmentUpdate.extractionAttempts = null;
            attachmentUpdate.extractionNextAttemptAt = null;
            attachmentUpdate.extractionError = null;
        }
        // `asEntity()`: Mongo `find()` returns plain documents, for which `update()` is unversioned - two
        // overlapping runs could otherwise both stamp the attachment (one orphaning its extracted-text blob).
        try {
            await this.attachmentRepo!.update(attachmentUpdate, asEntity(this.attachmentRepo!, attachment), { ignoreACL: true });
        } catch (err) {
            // Lost the race (or the write failed) - nothing references this run's text blob, so don't leak it.
            await this.blobStore!.delete(extractedTextBlobKey).catch(() => undefined);
            throw err;
        }

        if (text && text.length > 0 && message) {
            await this.invalidateSearchIndex(message.uid);
        }
    }

    /** Whether the attachment's message, read again after a (possibly long) extraction, is now stored zero-access sealed. */
    private async sealedSince(attachment: A): Promise<boolean> {
        const current: M | undefined = await this.messageRepo!.findOne(attachment.messageUid, { ignoreACL: true, includeDeleted: true, skipCache: true });
        return !!current && !current.encrypted && !!(current as any).zeroAccess;
    }

    /**
     * Puts off an attachment of a message stored zero-access sealed, without extracting or stamping it: an empty stamp would keep it from
     * ever being extracted, and a sealed draft's uploads are the rows its message is sent with once it is saved readable (zero-access
     * turned off meanwhile), whose attachment text must then be indexed. Not a failed attempt: the bookkeeping is reset
     * (`extractionAttempts` 0, so the backoff query applies), and a successful extraction later clears it. The rows of a sealed draft that
     * is sent are removed when its sealed Sent copy is filed.
     *
     * Put off for as long as the attachment is old - at least `zero_access_defer_seconds`, at most `zero_access_defer_max_seconds` - so a
     * draft being worked on is looked at again soon and one long abandoned about once a day, not every few minutes for ever.
     */
    private async deferWhileSealed(attachment: A): Promise<void> {
        // A row without a (valid) creation date counts as new.
        const ageSeconds: number = (Date.now() - new Date((attachment as any).dateCreated).getTime()) / 1000 || 0;
        const delaySeconds: number = Math.min(Math.max(this.zeroAccessDeferSeconds, ageSeconds), Math.max(this.zeroAccessDeferSeconds, this.zeroAccessDeferMaxSeconds));
        await this.attachmentRepo!.update(
            {
                uid: attachment.uid,
                version: (attachment as any).version,
                extractionAttempts: 0,
                extractionNextAttemptAt: new Date(Date.now() + delaySeconds * 1000),
                extractionError: null,
            } as any,
            asEntity(this.attachmentRepo!, attachment),
            { ignoreACL: true },
        );
    }

    /**
     * Marks the message for re-indexing, now that one of its attachments has extractable text, if it has already been
     * search-indexed.
     *
     * The message is RE-READ here, after the attachment's `extractedTextBlobKey` was committed, rather than trusting
     * the copy read before extraction: a `SearchIndexJob` run could have indexed and stamped it (without this text)
     * in between, and the stale copy would still say "not indexed". Paired with `SearchIndexJob`'s own post-stamp
     * re-check of the message's extracted attachments, this closes the race from both sides: whichever of the two
     * commits last sees the other's write. A message that is still unindexed is left untouched - `SearchIndexJob`
     * will pick up the text when it indexes it.
     *
     * Version-checked (`asEntity()`), re-reading and retrying on a conflict (e.g. a concurrent flag change), so a
     * concurrent edit is neither clobbered nor allowed to swallow the invalidation.
     */
    private async invalidateSearchIndex(messageUid: string): Promise<void> {
        for (let attempt = 0; attempt < MAX_INVALIDATE_ATTEMPTS; attempt++) {
            let current: M | undefined;
            try {
                current = await this.messageRepo!.findOne(messageUid, { ignoreACL: true, includeDeleted: true, skipCache: true });
            } catch (err: any) {
                this.logger?.warn(`AttachmentExtractionJob: failed to re-read message ${messageUid} for re-indexing: ${err?.message}`);
                return;
            }
            if (!current?.searchIndexedAt) {
                return;
            }
            try {
                // Explicit `null`, not `undefined`: TypeORM's `Repository.update()` silently drops any property
                // whose value is `undefined` from its generated `SET` clause, so on the SQL backend an
                // `undefined` here would leave the persisted `searchIndexedAt` completely untouched (still
                // reporting "already indexed") - a real, confirmed cross-backend bug caught by real-database
                // testing. MongoDB's own `updateOne($set: ...)` happens to coerce either value to `null`
                // equivalently, so `null` is correct there too.
                //
                // `SearchIndexJob`'s own retry bookkeeping is reset too, so the re-index gets a full set of attempts.
                await this.messageRepo!.update(
                    {
                        uid: current.uid,
                        version: (current as any).version,
                        searchIndexedAt: null,
                        searchIndexAttempts: null,
                        searchIndexNextAttemptAt: null,
                        searchIndexError: null,
                    } as any,
                    asEntity(this.messageRepo!, current),
                    { ignoreACL: true, skipPush: true },
                );
                return;
            } catch (err: any) {
                if (attempt === MAX_INVALIDATE_ATTEMPTS - 1) {
                    this.logger?.warn(`AttachmentExtractionJob: failed to mark message ${messageUid} for re-indexing: ${err?.message}`);
                }
            }
        }
    }
}
