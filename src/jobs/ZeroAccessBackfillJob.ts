///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import type { BlobStore } from "../blob/BlobStore.js";
import { FolderType, type Folder, type Mailbox, type Message } from "../models/types.js";
import { settleZeroAccessTypes } from "../util/ZeroAccessUtils.js";
import type { MessageBlobRepos } from "../util/BlobReferenceUtils.js";
import { asEntity } from "../util/EntityUtils.js";
import { findPagesByUid } from "../util/MailboxContentUtils.js";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
import { newZeroAccessWriter, type ZeroAccessSealedFields, type ZeroAccessWriter } from "../zeroaccess/ZeroAccessWriter.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;

/** The longest error message kept on `Message.zeroAccessBackfillError`. */
const MAX_ERROR_LENGTH = 1000;

/**
 * Seals the mail a mailbox already had when zero-access encryption became active for it (`specs/search.md` §3, *Existing mail*):
 * every message still stored readable - delivered, sent, imported, drafts, deleted-but-restorable - is encrypted to the mailbox's
 * zero-access key exactly as delivery would have done (`ZeroAccessWriter`), indexed into its week (by the message's own receipt
 * date), and its readable copies removed: the body blob (unless another message still shares it), the sanitized HTML, and the
 * attachment rows and blobs. The message is then indexed again by `SearchIndexJob`, which now sees only its metadata.
 *
 * Each run seals at most `batch_size` messages across all mailboxes, newest first within a mailbox, so the newest mail is protected
 * first and a large backlog is worked through over many runs. It is idempotent: a message is selected while its `zeroAccess` is unset,
 * and the sealed blob and index entry are keyed by the message, so a run interrupted halfway is completed by the next. A message it
 * can't seal (its body is unreadable) gets `zeroAccessBackfillError` and is never selected again, so it can't block the rest.
 *
 * Messages in Outbox are left alone - they are being sent, and `ScheduledSendJob` seals the Sent Items copy - and so is mail the
 * sender encrypted end to end. Turning zero-access off never decrypts anything (the server can't): this job only ever seals.
 */
export abstract class ZeroAccessBackfillJob<M extends Message, X extends Mailbox, F extends Folder> extends BackgroundService {
    protected abstract messageClass: any;
    protected abstract mailboxClass: any;
    protected abstract folderClass: any;
    protected abstract attachmentClass: any;
    protected abstract quarantineEntryClass: any;
    protected abstract ingestQueueEntryClass: any;
    protected abstract encryptionPolicyClass: any;
    protected abstract zeroAccessIndexEntryClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    protected messageRepo?: RecoverableRepoUtils<M>;
    protected mailboxRepo?: RepoUtils<X>;
    protected folderRepo?: RepoUtils<F>;
    protected blobRepos: MessageBlobRepos = {};
    protected zeroAccessWriter?: ZeroAccessWriter;

    @Inject("BlobStore")
    protected blobStore?: BlobStore;

    @Config("mail:jobs:zero_access_backfill:schedule", "0 * * * * *")
    private scheduleExpr: string = "0 * * * * *";

    @Config("mail:jobs:zero_access_backfill:batch_size", 100)
    private batchSize: number = 100;

    @Logger
    protected logger: any;

    public get schedule(): string | undefined {
        return this.scheduleExpr;
    }

    @Init
    public async init(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        const repo = async (cls: any, type: any = RepoUtils): Promise<any> => await this._objectFactory!.newInstance(type, { name: cls.name, args: [cls] });
        this.messageRepo ??= await repo(this.messageClass, RecoverableRepoUtils);
        this.mailboxRepo ??= await repo(this.mailboxClass);
        this.folderRepo ??= await repo(this.folderClass);
        this.blobRepos = {
            messageRepo: this.messageRepo,
            attachmentRepo: await repo(this.attachmentClass),
            quarantineEntryRepo: await repo(this.quarantineEntryClass),
            ingestQueueEntryRepo: await repo(this.ingestQueueEntryClass),
        };
        this.zeroAccessWriter ??= await newZeroAccessWriter(this._objectFactory, this.encryptionPolicyClass, this.zeroAccessIndexEntryClass);
    }

    public async start(): Promise<void> {
        // Processing happens entirely in `run()`.
    }

    public stop(): Promise<void> | void {
        // Do nothing
    }

    public async run(): Promise<void> {
        if (!this.zeroAccessWriter || !this.blobStore || !this.messageRepo) {
            return;
        }
        let budget: number = this.batchSize;
        for await (const page of findPagesByUid<X>(this.mailboxRepo!, {})) {
            for (const mailbox of page) {
                if (budget <= 0) {
                    return;
                }
                if (!(mailbox.zeroAccessKeys ?? []).length) {
                    continue;
                }
                await this.settleTypes(mailbox);
                if (!(await this.zeroAccessWriter.target(mailbox))) {
                    continue;
                }
                budget -= await this.backfillMailbox(mailbox, budget);
            }
        }
    }

    /**
     * Decides the data types a mailbox that already has zero-access hasn't decided yet - one from before calendar, contacts and tasks
     * could be protected - from the owner's devices (`specs/search.md` §3 *What It Covers*). Mail that is already protected stays so.
     * Leaves a mailbox whose owner turned zero-access off alone: turning it back on decides them.
     */
    private async settleTypes(mailbox: X): Promise<void> {
        const settled = mailbox.zeroAccessEnabled === false ? undefined : settleZeroAccessTypes(mailbox, false);
        if (settled) {
            Object.assign(
                mailbox,
                await this.mailboxRepo!.update({ uid: mailbox.uid, version: (mailbox as any).version, zeroAccessTypes: settled } as any, mailbox, { ignoreACL: true }),
            );
        }
    }

    /** Seals up to `limit` of `mailbox`'s readable messages, newest first, and returns how many it attempted. */
    private async backfillMailbox(mailbox: X, limit: number): Promise<number> {
        const folders: F[] = await this.folderRepo!.find({ mailboxUid: mailbox.uid, limit: 10_000 } as any, { ignoreACL: true, limit: 10_000 });
        const drafts: Set<string> = new Set(folders.filter((f) => f.type === FolderType.DRAFTS).map((f) => f.uid));
        const outbox: Set<string> = new Set(folders.filter((f) => f.type === FolderType.OUTBOX).map((f) => f.uid));
        // `limit` baked into the query too (SQL reads only that); Outbox is skipped in code, so a few extra rows are asked for. `find()`
        // returns a soft-deleted (restorable) row only for an explicit `deleted: true`, so those - still readable mail at rest - are a
        // second query, after the live ones.
        const pageSize: number = limit + 100;
        const query = (deleted?: true) =>
            this.messageRepo!.find(
                {
                    mailboxUid: mailbox.uid,
                    zeroAccess: null,
                    zeroAccessBackfillError: null,
                    encrypted: "ne(true)",
                    ...(deleted ? { deleted: true } : {}),
                    sort: { receivedDate: "DESC", uid: "ASC" },
                    limit: pageSize,
                } as any,
                { ignoreACL: true, limit: pageSize },
            );
        const candidates: M[] = [...(await query()), ...(await query(true))];
        let attempted: number = 0;
        for (const message of candidates) {
            if (attempted >= limit) {
                break;
            }
            if (outbox.has(message.folderUid) || message.encrypted) {
                continue;
            }
            attempted++;
            if (!(await this.sealMessage(mailbox, message, drafts.has(message.folderUid)))) {
                // Zero-access stopped being active for this mailbox meanwhile: leave the rest for when it is again.
                break;
            }
        }
        return attempted;
    }

    /** Seals one message; `false` when zero-access is no longer active for its mailbox (nothing was changed). */
    private async sealMessage(mailbox: X, message: M, isDraft: boolean): Promise<boolean> {
        let raw: Buffer;
        try {
            raw = await this.blobStore!.get(message.bodyBlobKey);
        } catch (err: any) {
            await this.recordFailure(message, `The message body couldn't be read: ${err?.message ?? err}`);
            return true;
        }
        let sealed: ZeroAccessSealedFields | undefined;
        try {
            const receivedAt: Date = new Date(message.receivedDate ?? message.sentDate ?? Date.now());
            sealed = isDraft
                ? await this.zeroAccessWriter!.sealDraft(mailbox, raw, message.uid, receivedAt)
                : await this.zeroAccessWriter!.sealRaw(mailbox, raw, message.uid, receivedAt);
        } catch (err: any) {
            await this.recordFailure(message, `The message couldn't be sealed: ${err?.message ?? err}`);
            return true;
        }
        if (!sealed) {
            return false;
        }
        const previous: (string | undefined)[] = [message.bodyBlobKey, (message as any).sanitizedHtmlBlobKey];
        try {
            await this.messageRepo!.update(
                {
                    uid: message.uid,
                    version: (message as any).version,
                    subject: sealed.subject,
                    bodyPreview: sealed.bodyPreview,
                    bodyBlobKey: sealed.bodyBlobKey,
                    sanitizedHtmlBlobKey: null,
                    zeroAccess: sealed.zeroAccess,
                    // Indexed again, now as metadata only: the server-side search document still holds the readable text.
                    searchIndexedAt: null,
                } as any,
                asEntity(this.messageRepo!, message),
                { ignoreACL: true, includeDeleted: true } as any,
            );
        } catch (err: any) {
            // Changed meanwhile (a move, a flag): the next run picks it up again. A draft's fresh blob isn't the message's.
            if (isDraft) {
                await this.blobStore!.delete(sealed.bodyBlobKey).catch(() => undefined);
            }
            this.logger?.debug?.(`ZeroAccessBackfillJob: message ${message.uid} changed while it was sealed; retrying later: ${err?.message}`);
            return true;
        }
        try {
            await this.zeroAccessWriter!.discardPlaintext(this.blobRepos, message.uid, previous);
        } catch (err: any) {
            this.logger?.warn(`ZeroAccessBackfillJob: message ${message.uid} is sealed but its readable copies couldn't all be removed: ${err?.message}`);
        }
        return true;
    }

    private async recordFailure(message: M, error: string): Promise<void> {
        this.logger?.warn(`ZeroAccessBackfillJob: leaving message ${message.uid} unsealed: ${error}`);
        try {
            await this.messageRepo!.update(
                { uid: message.uid, version: (message as any).version, zeroAccessBackfillError: error.slice(0, MAX_ERROR_LENGTH) } as any,
                asEntity(this.messageRepo!, message),
                { ignoreACL: true, includeDeleted: true } as any,
            );
        } catch {
            // Selected again next run.
        }
    }
}
