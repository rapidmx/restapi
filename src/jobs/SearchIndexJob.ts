///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { simpleParser, ParsedMail } from "mailparser";
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { asEntity } from "../util/EntityUtils.js";
import { BlobStore } from "../blob/BlobStore.js";
import { SearchDocument, SearchProvider } from "../search/SearchProvider.js";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
import { removeFromSearchIndex } from "../util/SearchIndexUtils.js";
import { isEncryptedBody } from "../util/SmimeUtils.js";
import { Attachment, Mailbox, Message, RecipientType } from "../models/types.js";
import { newZeroAccessWriter, type ZeroAccessWriter } from "../zeroaccess/ZeroAccessWriter.js";
import { PROTECTED_SUBJECT } from "../zeroaccess/ZeroAccessSealer.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;

/** Well above any real message's attachment count - see `buildDocument()`'s own note on why this must be
 * baked into the query object, not just `options`. */
const MAX_ATTACHMENTS_PER_MESSAGE = 1000;

/** The longest error message persisted onto `Message.searchIndexError`. */
const MAX_ERROR_LENGTH = 1000;

/**
 * Reconciles `SearchProvider`'s index against `Message` records that haven't been indexed yet
 * (`Message.searchIndexedAt` is unset). This is what decouples "committed to the primary datastore" from
 * "visible in search" (see `SearchProvider`'s doc comment) — a just-ingested or just-sent message is readable
 * via the standard REST API immediately, and becomes findable via search within one run of this job.
 *
 * Scoped to `Message` search for the initial pragmatic subset, since full-text search over subject/body/
 * attachments was the explicit requirement driving this subsystem; indexing Contacts/CalendarEvents/Notes/
 * Tasks is a natural extension (the `SearchProvider`/`SearchDocument` interfaces already support it) but is
 * deliberately left for a later pass rather than built speculatively here.
 *
 * `AttachmentExtractionJob` clears `searchIndexedAt` back to `undefined` on a message whose attachment text
 * extraction completes *after* this job already indexed it once, so it gets picked up again with the newly
 * available attachment text.
 *
 * A message that fails to index (its document can't be built, or the provider rejects it) is retried with
 * exponential backoff (`searchIndexAttempts`/`searchIndexNextAttemptAt`, base delay
 * `mail:jobs:search_index:retry_backoff_seconds`) up to `mail:jobs:search_index:max_attempts` times, then left
 * unindexed with `searchIndexError` recorded - excluded from every later candidate query, so a permanently
 * failing message can never occupy the head of the (oldest-first) queue and starve the rest of the backlog.
 *
 * Zero-access (`specs/search.md` §3): a sealed message is indexed as metadata only, and so is any message still stored readable in a
 * mailbox whose mail is zero-access - a draft assembled readable to be sent, waiting in Outbox or moved back to Drafts, or mail the
 * backfill hasn't reached yet - under the placeholder subject, without its body or attachment text. Whatever cleared its stamp (a move, a
 * flag, an attachment extracted late), its readable text never reaches the search provider. That metadata document is what replaces a
 * readable one the provider may still hold, so such a message is never simply given up on: when its retries run out its document is
 * removed, and while that removal fails it is retried at the longest backoff.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class SearchIndexJob<M extends Message, A extends Attachment> extends BackgroundService {
    protected abstract messageClass: any;
    protected abstract attachmentClass: any;
    /** The backend's `Mailbox`, `EncryptionPolicy` and `ZeroAccessIndexEntry` models: which mailboxes' mail is zero-access. Optional:
     * without them every readable message is indexed in full, as before zero-access. */
    protected mailboxClass?: any;
    protected encryptionPolicyClass?: any;
    protected zeroAccessIndexEntryClass?: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    protected messageRepo?: RecoverableRepoUtils<M>;
    protected attachmentRepo?: RepoUtils<A>;
    protected mailboxRepo?: RepoUtils<any>;
    protected zeroAccessWriter?: ZeroAccessWriter;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    @Inject("SearchProvider")
    private searchProvider?: SearchProvider;

    @Config("mail:jobs:search_index:schedule", "*/15 * * * * *")
    private scheduleExpr: string = "*/15 * * * * *";

    @Config("mail:jobs:search_index:batch_size", 50)
    private batchSize: number = 50;

    @Config("mail:jobs:search_index:max_attempts", 5)
    private maxAttempts: number = 5;

    @Config("mail:jobs:search_index:retry_backoff_seconds", 60)
    private retryBackoffSeconds: number = 60;

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
        if (!this.messageRepo && this.messageClass) {
            this.messageRepo = await this._objectFactory.newInstance(RecoverableRepoUtils, {
                name: this.messageClass.name,
                args: [this.messageClass],
            });
        }
        if (!this.attachmentRepo && this.attachmentClass) {
            this.attachmentRepo = await this._objectFactory.newInstance(RepoUtils, {
                name: this.attachmentClass.name,
                args: [this.attachmentClass],
            });
        }
        if (!this.mailboxRepo && this.mailboxClass) {
            this.mailboxRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.mailboxClass.name, args: [this.mailboxClass] });
        }
        this.zeroAccessWriter ??= await newZeroAccessWriter(this._objectFactory, this.encryptionPolicyClass, this.zeroAccessIndexEntryClass);
    }

    public async start(): Promise<void> {
        // Nothing to do at startup beyond `init()` above; processing happens entirely in `run()`.
    }

    public stop(): Promise<void> | void {
        // Do nothing
    }

    public async run(): Promise<void> {
        if (!this.messageRepo || !this.searchProvider || !this.blobStore) {
            return;
        }

        const now: Date = new Date();
        // `limit` must be passed both via `options` (used by the Mongo backend) *and* baked into the query
        // object itself (all `ModelUtils.buildSearchQuerySQL` reads - it ignores `options.limit` entirely and
        // falls back to its own default of 100 otherwise). Confirmed by real-database testing: on the SQL
        // backend, `options.limit` alone silently caps at 100 regardless of the configured batch size.
        //
        // Candidates are a message that has never failed, or one that has failed fewer than `maxAttempts` times
        // and whose backoff has elapsed - a message at `maxAttempts` is excluded outright. Sorted oldest-first
        // (with `uid` as a tiebreaker) so batches are drawn in a stable order.
        const pending: M[] = await this.messageRepo.find(
            {
                searchIndexedAt: null,
                $or: [
                    { searchIndexAttempts: "null" },
                    {
                        searchIndexAttempts: `lt(${this.maxAttempts})`,
                        searchIndexNextAttemptAt: `lte(${now.toISOString()})`,
                    },
                ],
                sort: { dateCreated: "ASC", uid: "ASC" },
                limit: this.batchSize,
            } as any,
            { ignoreACL: true, limit: this.batchSize },
        );

        const docs: SearchDocument[] = [];
        // Only messages the provider actually reports as indexed get stamped `searchIndexedAt` below - a message
        // whose `buildDocument()` throws (e.g. a transient blob-store failure) or that the provider rejects must
        // be picked up again by a later run (up to `maxAttempts`), not silently marked "already indexed".
        const built: M[] = [];
        // Per built message, the attachment uids whose extracted text went into its document (only for a message
        // whose attachments were actually read) - re-checked after stamping, see `recheckAttachmentText()`.
        const indexedAttachmentUids: Map<string, Set<string>> = new Map();
        // Per readable message's mailbox, whether its mail is zero-access (`undefined`: it couldn't be told this run).
        const zeroAccessMailboxes: Map<string, boolean | undefined> = await this.zeroAccessMailboxes(pending);
        // The messages indexed as metadata only because of zero-access: their document replaces a readable one (`recordFailure()`).
        const replacesReadable: Set<string> = new Set();
        for (const message of pending) {
            const sealed: boolean = !!(message as any).zeroAccess;
            const inZeroAccessMailbox: boolean | undefined =
                !sealed && zeroAccessMailboxes.has(message.mailboxUid) ? zeroAccessMailboxes.get(message.mailboxUid) : false;
            if (inZeroAccessMailbox === undefined) {
                // Indexed in full it could put a zero-access mailbox's plaintext in the index: left for a later run. Its document may be
                // a readable one a zero-access mailbox must not keep, so it is treated as one that does.
                await this.recordFailure(message, "couldn't tell whether its mailbox's mail is zero-access", true);
                continue;
            }
            if (sealed || inZeroAccessMailbox) {
                replacesReadable.add(message.uid);
            }
            try {
                const seen: Set<string> = new Set();
                const doc: SearchDocument = await this.buildDocument(message, seen, inZeroAccessMailbox && !message.encrypted);
                docs.push(doc);
                // Only a message whose attachments were read: `recheckAttachmentText()` would otherwise clear the stamp of a sealed or
                // metadata-only message on every pass, for attachment text its document never holds.
                if (message.hasAttachments && !doc.metadataOnly) {
                    indexedAttachmentUids.set(message.uid, seen);
                }
                built.push(message);
            } catch (err: any) {
                await this.recordFailure(message, `failed to build search document: ${err?.message}`, replacesReadable.has(message.uid));
            }
        }

        if (docs.length === 0) {
            return;
        }

        let indexedUids: Set<string>;
        try {
            const result: string[] = await this.searchProvider.bulkIndex(docs);
            // Defensive: a provider not honoring the `string[]` contract (e.g. plain JS) is treated as having
            // indexed the whole batch, matching this job's behavior before per-document results existed.
            indexedUids = new Set(Array.isArray(result) ? result : docs.map((doc) => doc.entityUid));
        } catch (err: any) {
            // A whole-batch failure (e.g. the provider is unreachable): nothing can be assumed indexed.
            for (const message of built) {
                await this.recordFailure(message, `bulk index failed: ${err?.message}`, replacesReadable.has(message.uid));
            }
            return;
        }

        const indexedAt: Date = new Date();
        for (const message of built) {
            if (!indexedUids.has(message.uid)) {
                await this.recordFailure(message, "search provider did not index the document", replacesReadable.has(message.uid));
                continue;
            }
            const update: any = { uid: message.uid, version: (message as any).version, searchIndexedAt: indexedAt };
            if (
                (message.searchIndexAttempts ?? null) !== null ||
                (message.searchIndexNextAttemptAt ?? null) !== null ||
                (message.searchIndexError ?? null) !== null
            ) {
                // Explicit `null` (not `undefined`) so TypeORM's `update()` actually clears these on SQL.
                update.searchIndexAttempts = null;
                update.searchIndexNextAttemptAt = null;
                update.searchIndexError = null;
            }
            let stamped: M;
            try {
                // `asEntity()`: Mongo `find()` returns plain documents, for which `update()` skips its optimistic
                // lock entirely - a concurrent edit (e.g. a flag change) could otherwise be clobbered, or a stale
                // stamp could land over a newer content change that cleared `searchIndexedAt`.
                stamped = await this.messageRepo.update(update, asEntity(this.messageRepo, message), { ignoreACL: true, skipPush: true });
            } catch (err: any) {
                // e.g. a concurrent edit bumped the version - the message is simply re-indexed on a later run.
                this.logger?.warn(`SearchIndexJob: failed to stamp searchIndexedAt on message ${message.uid}: ${err?.message}`);
                await this.removeIfGone(message.uid);
                continue;
            }
            const seen: Set<string> | undefined = indexedAttachmentUids.get(message.uid);
            if (seen) {
                await this.recheckAttachmentText(stamped ?? message, seen);
            }
        }
    }

    /**
     * Closes the race with `AttachmentExtractionJob`: an attachment whose text was extracted AFTER this run read the
     * message's attachments, but whose extraction job checked the message BEFORE this run stamped it, would otherwise
     * leave the message stamped "indexed" without that text forever. Re-reads the message's extracted attachments
     * after the stamp is committed; if any wasn't in the indexed document, the stamp is cleared again (version-checked
     * against the stamp just written, retried against a fresh read on a conflict) so the next run re-indexes it.
     * `AttachmentExtractionJob.invalidateSearchIndex()` re-reads the message after committing the attachment, so
     * whichever write lands last sees the other.
     */
    private async recheckAttachmentText(stamped: M, seen: Set<string>): Promise<void> {
        try {
            const attachments: A[] = await this.attachmentRepo!.find(
                { messageUid: stamped.uid, extractedTextBlobKey: "ne(null)", limit: MAX_ATTACHMENTS_PER_MESSAGE } as any,
                { ignoreACL: true, limit: MAX_ATTACHMENTS_PER_MESSAGE, skipCache: true },
            );
            if (attachments.every((attachment) => seen.has(attachment.uid))) {
                return;
            }
            let current: M | undefined = stamped;
            for (let attempt = 0; current?.searchIndexedAt && attempt < 3; attempt++) {
                try {
                    await this.messageRepo!.update(
                        { uid: current.uid, version: (current as any).version, searchIndexedAt: null } as any,
                        asEntity(this.messageRepo!, current),
                        { ignoreACL: true, skipPush: true },
                    );
                    return;
                } catch {
                    current = await this.messageRepo!.findOne(stamped.uid, { ignoreACL: true, includeDeleted: true, skipCache: true });
                }
            }
        } catch (err: any) {
            this.logger?.warn(`SearchIndexJob: failed to re-check attachment text for message ${stamped.uid}: ${err?.message}`);
        }
    }

    /**
     * Called when stamping `searchIndexedAt` fails (typically a version conflict): if the message was soft-deleted or
     * purged while this run was building/indexing its document, the document just written would otherwise resurrect
     * it in search - the delete path's own index removal may already have run before this run's `bulkIndex()`. A
     * still-live message is left alone: it stays unstamped and is simply re-indexed on a later run.
     */
    private async removeIfGone(uid: string): Promise<void> {
        try {
            const current: M | undefined = await this.messageRepo!.findOne(uid, { ignoreACL: true, includeDeleted: true, skipCache: true });
            if (current && (current as any).deleted !== true) {
                return;
            }
        } catch (err: any) {
            this.logger?.warn(`SearchIndexJob: failed to re-check message ${uid} after a failed stamp: ${err?.message}`);
            return;
        }
        await removeFromSearchIndex(this.searchProvider, "message", uid, this.logger);
    }

    /**
     * Whether the mail of each mailbox `pending` has a readable message in is zero-access (`ZeroAccessWriter.target()`), read once per
     * mailbox, with the administrator's setting read once per run. A mailbox whose state couldn't be read maps to `undefined`. Empty
     * without the zero-access models, or with no readable message.
     */
    private async zeroAccessMailboxes(pending: M[]): Promise<Map<string, boolean | undefined>> {
        const result: Map<string, boolean | undefined> = new Map();
        const uids: string[] = [...new Set(pending.filter((message) => !(message as any).zeroAccess).map((message) => message.mailboxUid))];
        if (uids.length === 0 || !this.zeroAccessWriter || !this.mailboxRepo) {
            return result;
        }
        let allowed: boolean;
        try {
            allowed = await this.zeroAccessWriter.allowed();
        } catch (err: any) {
            this.logger?.warn(`SearchIndexJob: couldn't read whether zero-access encryption is allowed: ${err?.message}`);
            return new Map(uids.map((uid) => [uid, undefined]));
        }
        for (const uid of uids) {
            try {
                const mailbox: Mailbox | undefined = allowed ? await this.mailboxRepo.findOne(uid, { ignoreACL: true }) : undefined;
                result.set(uid, !!mailbox && !!(await this.zeroAccessWriter.target(mailbox, "mail", allowed)));
            } catch (err: any) {
                this.logger?.warn(`SearchIndexJob: couldn't read mailbox ${uid}'s zero-access state: ${err?.message}`);
                result.set(uid, undefined);
            }
        }
        return result;
    }

    /**
     * Records one failed indexing attempt on `message`: increments `searchIndexAttempts`, schedules the next
     * attempt with exponential backoff, and stores the error. Once `maxAttempts` is reached the message is no
     * longer selected by `run()` and the failure is logged as an error.
     *
     * `replacesReadable`: the message's document is metadata only because of zero-access, and replaces one the provider may still hold
     * with its readable text. When its attempts run out that document is removed instead; while the removal fails, the message stays
     * selected and is retried at the longest backoff, so a readable document is never left behind for good.
     */
    private async recordFailure(message: M, reason: string, replacesReadable: boolean): Promise<void> {
        let attempts: number = (message.searchIndexAttempts ?? 0) + 1;
        let exhausted: boolean = attempts >= this.maxAttempts;
        if (exhausted && replacesReadable) {
            if ((await removeFromSearchIndex(this.searchProvider, "message", message.uid, this.logger)) > 0) {
                exhausted = false;
                attempts = Math.max(this.maxAttempts - 1, 0);
                reason = `${reason} (its readable document couldn't be removed either, so it is retried)`;
            } else {
                reason = `${reason} (its document was removed from the index)`;
            }
        }
        const delayMs: number = this.retryBackoffSeconds * 1000 * Math.pow(2, Math.max(attempts - 1, 0));
        if (exhausted) {
            this.logger?.error(`SearchIndexJob: giving up on message ${message.uid} after ${attempts} failed attempt(s): ${reason}`);
        } else {
            this.logger?.warn(`SearchIndexJob: attempt ${attempts} to index message ${message.uid} failed: ${reason}`);
        }
        try {
            await this.messageRepo!.update(
                {
                    uid: message.uid,
                    version: (message as any).version,
                    searchIndexAttempts: attempts,
                    searchIndexNextAttemptAt: exhausted ? null : new Date(Date.now() + delayMs),
                    searchIndexError: reason.slice(0, MAX_ERROR_LENGTH),
                } as any,
                asEntity(this.messageRepo!, message),
                { ignoreACL: true, skipPush: true },
            );
        } catch (err: any) {
            this.logger?.warn(`SearchIndexJob: failed to record indexing failure on message ${message.uid}: ${err?.message}`);
        }
    }

    /** `zeroAccessMailbox`: `message` is still readable in a mailbox whose mail is zero-access, and is indexed as a sealed one is. */
    private async buildDocument(message: M, indexedAttachmentUids?: Set<string>, zeroAccessMailbox: boolean = false): Promise<SearchDocument> {
        // A zero-access message is stored sealed: there is nothing here to read, so its metadata is indexed without fetching the blob.
        // Its content is searched on the owner's devices, from its sealed index entry (`specs/search.md` §7). One still readable in a
        // zero-access mailbox (a draft assembled for sending) gets the same document, under the placeholder subject its sealed copy gets.
        const sealed: boolean = !!(message as any).zeroAccess || zeroAccessMailbox;
        // `skipImageLinks`: otherwise a related image is inlined into the HTML as a `data:` URI - base64 of the whole image, which
        // is what would be indexed (and held in memory) for an HTML-only message.
        const parsed: ParsedMail | undefined = sealed ? undefined : await simpleParser(await this.blobStore!.get(message.bodyBlobKey), { skipImageLinks: true });
        // An S/MIME-encrypted body is ciphertext to this server - indexing it (or any attachment text
        // extracted from inside it) would only ever put garbage into the index, not a privacy leak by itself,
        // but garbage nonetheless. `Message.subject`/`participants`/`dateForSort` below are unaffected: they
        // come from the outer RFC 5322 headers, which S/MIME's `EnvelopedData` never encrypts (a sender using
        // RFC 9788 header protection on top already replaces a real Subject with a non-revealing placeholder
        // in that same outer header, so no extra detection is needed here for that case either).
        const encrypted: boolean = !parsed || isEncryptedBody(parsed);
        const body: string = !parsed || encrypted ? "" : typeof parsed.text === "string" ? parsed.text : (parsed.html || "").toString();

        const attachmentText: string[] = [];
        if (!encrypted && message.hasAttachments) {
            // `limit` baked into the query object itself, not just `options` - `ModelUtils.buildSearchQuerySQL`
            // ignores `options.limit` and falls back to its own 100-row default otherwise (see `ScanQueueJob`'s
            // identical note), which would otherwise silently index only an arbitrary 100 of a message's
            // attachments if it ever had more.
            const attachments: A[] = await this.attachmentRepo!.find(
                { messageUid: message.uid, extractedTextBlobKey: "ne(null)", limit: MAX_ATTACHMENTS_PER_MESSAGE } as any,
                { ignoreACL: true, limit: MAX_ATTACHMENTS_PER_MESSAGE },
            );
            for (const attachment of attachments) {
                if (attachment.extractedTextBlobKey) {
                    const text: Buffer = await this.blobStore!.get(attachment.extractedTextBlobKey);
                    attachmentText.push(text.toString("utf-8"));
                    indexedAttachmentUids?.add(attachment.uid);
                }
            }
        }

        const to: string[] = message.recipients.filter((r) => r.type === RecipientType.TO).map((r) => r.address);
        const cc: string[] = message.recipients.filter((r) => r.type === RecipientType.CC).map((r) => r.address);
        const participants: string[] = [message.from.address, ...message.recipients.map((r) => r.address)];

        const flags: string[] = [];
        flags.push(message.flags.read ? "read" : "unread");
        if (message.flags.flagged) {
            flags.push("flagged");
        }
        if (message.flags.answered) {
            flags.push("answered");
        }
        if (message.flags.forwarded) {
            flags.push("forwarded");
        }

        return {
            entityType: "message",
            entityUid: message.uid,
            mailboxUid: message.mailboxUid,
            subject: zeroAccessMailbox ? PROTECTED_SUBJECT : message.subject,
            body,
            attachmentText,
            participants,
            from: message.from.address,
            to,
            cc,
            dateForSort: message.sentDate,
            folderUid: message.folderUid,
            flags,
            labels: message.labelUids ?? [],
            hasAttachments: message.hasAttachments,
            metadataOnly: encrypted,
        };
    }
}
