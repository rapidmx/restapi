///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { ObjectDecorators } from "@rapidrest/core";
import { ApiErrors, BackgroundService, ModelUtils, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import type { BlobStore } from "../blob/BlobStore.js";
import { GoneBlobConfirmations } from "../blob/GoneBlobConfirmations.js";
import { FolderType, type Folder, type Mailbox, type Message, type ZeroAccessDataType } from "../models/types.js";
import { CONTACT_PHOTO_KEY_PREFIX } from "../routes/BaseContactRoute.js";
import { settleZeroAccessTypes } from "../util/ZeroAccessUtils.js";
import { deleteBlobsIfUnreferenced, type MessageBlobRepos } from "../util/BlobReferenceUtils.js";
import { asEntity } from "../util/EntityUtils.js";
import { findPagesByUid } from "../util/MailboxContentUtils.js";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
import { removeFromSearchIndex, SEARCH_REINDEX } from "../util/SearchIndexUtils.js";
import type { SearchProvider } from "../search/SearchProvider.js";
import { newZeroAccessWriter, type ZeroAccessSealedFields, type ZeroAccessWriter } from "../zeroaccess/ZeroAccessWriter.js";
import { sealFieldsOnWrite } from "../zeroaccess/ZeroAccessFieldSealer.js";
import { newZeroAccessRecordSealer, PROTECTED_FIELDS, type ZeroAccessRecordSealer } from "../zeroaccess/ZeroAccessRecordSealer.js";
import type { ZeroAccessTarget } from "../zeroaccess/ZeroAccessResolver.js";
import { sealToCertificate } from "../zeroaccess/ZeroAccessSealer.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;

/** The longest error message kept on `Message.zeroAccessBackfillError`. */
const MAX_ERROR_LENGTH = 1000;

/** The record types sealed field by field, in the order a run works through them after mail. */
const RECORD_TYPES: readonly ZeroAccessDataType[] = ["calendar", "contacts", "tasks"];

/**
 * Seals the mail a mailbox already had when zero-access encryption became active for it (`specs/search.md` §3, *Existing mail*):
 * every message still stored readable - delivered, sent, imported, drafts, deleted-but-restorable - is encrypted to the mailbox's
 * zero-access key exactly as delivery would have done (`ZeroAccessWriter`), indexed into its week (by the message's own receipt
 * date), and its readable copies removed: the body blob (unless another message still shares it), the sanitized HTML, and the
 * attachment rows and blobs - except a draft's, which are its working attachments and only lose their extracted text
 * (`ZeroAccessWriter.discardDraftPlaintext()`). A draft's index entry is written only once its sealed row is stored, so a seal that loses
 * to a concurrent write (a compose save, another replica's run) never touches the entry the winner wrote. The message is then indexed
 * again by `SearchIndexJob`, which now sees only its metadata - a deleted-but-restorable one too, by its pass over sealed soft-deleted
 * mail; its search document is also removed here at once (search leaves deleted messages out anyway).
 *
 * Each run seals at most `batch_size` messages across all mailboxes, newest first within a mailbox, so the newest mail is protected
 * first and a large backlog is worked through over many runs. It is idempotent: a message is selected while its `zeroAccess` is unset,
 * and the sealed blob and index entry are keyed by the message, so a run interrupted halfway is completed by the next. A message it
 * can never seal - its body is gone - gets `zeroAccessBackfillError` and is never selected again, so it can't block the rest; one that
 * failed for a reason that passes (the blob store or the database failing for a moment) is tried again next run. "Gone" means missing
 * for a day (`goneBlobs`), not just at one look: a local blob volume that failed to mount answers "not there" for every body, and
 * giving up on those would leave them readable for good once it is mounted again. A body that can't be parsed is still sealed whole
 * (`ZeroAccessWriter.sealRaw()`).
 *
 * Messages in Outbox are left alone while their send can still go ahead - due, scheduled or waiting out a retry (`scheduledSendTime`), or
 * claimed (a live `scheduledSendLeaseExpiresAt`) - since they are relayed from the readable copy and `ScheduledSendJob` seals the Sent
 * Items copy. A soft-deleted one keeps its schedule: `ScheduledSendJob` never relays it while it is deleted, and a restore resumes the
 * send (at its time, or at once when that has passed), so it stays readable under the same transient exception - but only until
 * `deleted_scheduled_send_days` (30) after the later of its scheduled time and its deletion, since nothing else bounds it (deleted mail
 * is purged only by a retention policy or an explicit purge). One whose send failed for good, that was relayed but never filed, or
 * that was deleted longer ago than that is nothing left to send: it is sealed, as a draft when it was never relayed (reopened and sent
 * again like any sealed draft), its schedule cleared, and as sent mail when it was. A relayed one deleted while its filing waits for a
 * retry is sealed at once - it has gone out - and keeps that schedule, so a restore has `ScheduledSendJob` file it into Sent Items, sealed
 * as it is. Mail the sender encrypted end to end is left alone. Turning zero-access off never decrypts anything (the server can't): this
 * job only ever seals.
 *
 * Calendar events, contacts and tasks are sealed the same way, per data type, once that type is protected for the mailbox (`specs/search.md`
 * §3 *What It Covers*), within the same budget and after its mail: each record that has no `sealedFields` yet gets its protected fields
 * sealed exactly as a write would (`sealFieldsOnWrite()`), and a contact's photo is stored again sealed. A record with nothing to seal
 * gets an empty `sealedFields`, so it isn't selected again; an event made from a zero-access invitation (`sealedContent`) is already
 * sealed. A contact whose photo blob is gone (missing for a day, as a body) is sealed without it. A record the write of its sealed
 * fields is refused for (anything but a concurrent change) gets `zeroAccessBackfillError` like a message, so it can't use up every
 * run's budget. A record edited while its type was off after it had been sealed keeps the fields edited then readable until it is next
 * edited.
 *
 * The administrator's "Allow zero-access encryption" is read once per run (nothing is sealed while it is off), and a mailbox's folders
 * only once it has mail to seal: a run over mailboxes with nothing left to do costs a few indexed queries each.
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
    /** The record models sealed per data type. Optional: a type whose model is unset isn't backfilled. */
    protected calendarEventClass?: any;
    protected contactClass?: any;
    protected taskClass?: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    protected messageRepo?: RecoverableRepoUtils<M>;
    protected mailboxRepo?: RepoUtils<X>;
    protected folderRepo?: RepoUtils<F>;
    protected blobRepos: MessageBlobRepos = {};
    protected zeroAccessWriter?: ZeroAccessWriter;
    protected recordSealer?: ZeroAccessRecordSealer;
    protected recordRepos: Partial<Record<ZeroAccessDataType, RecoverableRepoUtils<any>>> = {};

    @Inject("BlobStore")
    protected blobStore?: BlobStore;

    @Inject("SearchProvider")
    protected searchProvider?: SearchProvider;

    @Config("mail:jobs:zero_access_backfill:schedule", "0 * * * * *")
    private scheduleExpr: string = "0 * * * * *";

    @Config("mail:jobs:zero_access_backfill:batch_size", 100)
    private batchSize: number = 100;

    /** How many days a soft-deleted, still-scheduled Outbox message stays readable (restorable to be sent) after the later of its
     * scheduled time and its deletion, before it is sealed with its schedule cleared. */
    @Config("mail:jobs:zero_access_backfill:deleted_scheduled_send_days", 30)
    private deletedScheduledSendDays: number = 30;

    /** A body or contact photo the store says isn't there counts as gone only once it has been missing for a day. */
    protected goneBlobs: GoneBlobConfirmations = new GoneBlobConfirmations(24 * 3_600_000);

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
        this.recordSealer ??= await newZeroAccessRecordSealer(this._objectFactory, this.encryptionPolicyClass);
        const records: [ZeroAccessDataType, any][] = [
            ["calendar", this.calendarEventClass],
            ["contacts", this.contactClass],
            ["tasks", this.taskClass],
        ];
        for (const [type, cls] of records) {
            if (cls && !this.recordRepos[type]) {
                this.recordRepos[type] = await repo(cls, RecoverableRepoUtils);
            }
        }
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
        // Read once for the run, not once per mailbox and type.
        const allowed: boolean = await this.zeroAccessWriter.allowed();
        if (!allowed) {
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
                if (await this.zeroAccessWriter.target(mailbox, "mail", allowed)) {
                    budget -= await this.backfillMailbox(mailbox, budget);
                }
                for (const type of RECORD_TYPES) {
                    if (budget <= 0) {
                        return;
                    }
                    budget -= await this.backfillRecords(mailbox, type, budget, allowed);
                }
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

    /** Seals up to `limit` of `mailbox`'s `type` records not sealed yet - the deleted-but-restorable ones too - when `type` is protected
     * for it, and returns how many it attempted. Then contacts whose fields are sealed but whose photo is still readable: one written by
     * a writer that seals fields but not photos (a device), before the type was protected or in a mailbox it moved from. */
    private async backfillRecords(mailbox: X, type: ZeroAccessDataType, limit: number, allowed: boolean): Promise<number> {
        const repo: RecoverableRepoUtils<any> | undefined = this.recordRepos[type];
        const target: ZeroAccessTarget | undefined = repo && this.recordSealer ? await this.recordSealer.target(type, mailbox, allowed) : undefined;
        if (!repo || !target) {
            return 0;
        }
        const query = (selector: Record<string, any>, deleted?: true) =>
            repo.find(
                {
                    mailboxUid: mailbox.uid,
                    zeroAccessBackfillError: null,
                    ...selector,
                    ...(deleted ? { deleted: true } : {}),
                    sort: { uid: "ASC" },
                    limit,
                } as any,
                { ignoreACL: true, limit },
            );
        const selectors: Record<string, any>[] = [{ sealedFields: null, ...(type === "calendar" ? { sealedContent: null } : {}) }];
        if (type === "contacts") {
            selectors.push({
                photoBlobKey: `like(${CONTACT_PHOTO_KEY_PREFIX}*)`,
                $or: [{ photoSealed: ModelUtils.literal(false) }, { photoSealed: ModelUtils.literal(null) }],
            });
        }
        const candidates: any[] = [];
        const seen: Set<string> = new Set();
        for (const selector of selectors) {
            for (const deleted of [undefined, true] as const) {
                for (const record of candidates.length < limit ? await query(selector, deleted) : []) {
                    if (!seen.has(record.uid)) {
                        seen.add(record.uid);
                        candidates.push(record);
                    }
                }
            }
        }
        let attempted: number = 0;
        for (const record of candidates.slice(0, limit)) {
            attempted++;
            await this.sealRecord(repo, type, record, target);
        }
        return attempted;
    }

    /**
     * Seals one record's protected fields (and a contact's photo) to `target`. A record changed meanwhile, or whose photo can't be read
     * for a reason that passes or is missing but not yet for long enough to be gone (`goneBlobs`), is left for the next run; a photo
     * whose blob is gone is dropped from the record, which is sealed without it.
     * A record whose sealed write is refused for any other reason is marked (`zeroAccessBackfillError`) and never selected again.
     */
    private async sealRecord(repo: RecoverableRepoUtils<any>, type: ZeroAccessDataType, record: any, target: ZeroAccessTarget): Promise<void> {
        const fields = PROTECTED_FIELDS[type] ?? [];
        const patch: Record<string, any> = { uid: record.uid, version: record.version };
        for (const field of fields) {
            patch[field.name] = record[field.name];
        }
        let previousPhoto: string | undefined;
        if (type === "contacts" && !record.photoSealed && typeof record.photoBlobKey === "string" && record.photoBlobKey.startsWith(CONTACT_PHOTO_KEY_PREFIX)) {
            let photo: Buffer | undefined;
            try {
                photo = await this.blobStore!.get(record.photoBlobKey);
                this.goneBlobs.forget(record.photoBlobKey);
            } catch (err: any) {
                if (await this.blobExists(record.photoBlobKey)) {
                    this.logger?.warn(`ZeroAccessBackfillJob: contact ${record.uid}'s photo couldn't be read this run: ${err?.message ?? err}`);
                    return;
                }
                if (!this.goneBlobs.confirmed(record.photoBlobKey)) {
                    this.logger?.warn(`ZeroAccessBackfillJob: contact ${record.uid}'s photo isn't there; left until it has been missing for a while.`);
                    return;
                }
                // Gone: nothing readable is left to seal, and the record no longer names it.
                patch.photoBlobKey = null;
            }
            if (photo) {
                patch.photoBlobKey = `${CONTACT_PHOTO_KEY_PREFIX}${record.uid}/${crypto.randomUUID()}`;
                try {
                    await this.blobStore!.put(patch.photoBlobKey, await sealToCertificate(photo, target.certDer));
                } catch (err: any) {
                    this.logger?.warn(`ZeroAccessBackfillJob: contact ${record.uid}'s sealed photo couldn't be stored this run: ${err?.message ?? err}`);
                    return;
                }
                patch.photoSealed = true;
                previousPhoto = record.photoBlobKey;
            }
        }
        try {
            await sealFieldsOnWrite(patch, record, fields, target);
            // Nothing to seal: marked as done, so it isn't selected again.
            patch.sealedFields ??= {};
            await repo.update(patch, asEntity(repo, record), { ignoreACL: true, includeDeleted: true } as any);
        } catch (err: any) {
            if (patch.photoSealed) {
                await this.blobStore!.delete(patch.photoBlobKey).catch(() => undefined);
            }
            if (err?.code === ApiErrors.INVALID_OBJECT_VERSION) {
                this.logger?.debug?.(`ZeroAccessBackfillJob: ${type} ${record.uid} changed while it was sealed; retrying later: ${err?.message}`);
            } else {
                await this.recordRecordFailure(repo, type, record, `The record couldn't be sealed: ${err?.message ?? err}`);
            }
            return;
        }
        if (previousPhoto) {
            try {
                await deleteBlobsIfUnreferenced(this.blobStore!, [{ repo, fields: ["photoBlobKey"] }], [previousPhoto]);
            } catch (err: any) {
                this.logger?.warn(`ZeroAccessBackfillJob: contact ${record.uid}'s readable photo couldn't be removed: ${err?.message ?? err}`);
            }
        }
    }

    /** Marks a record the backfill can't seal, so it is never selected again. A failure to mark it leaves it for the next run. */
    private async recordRecordFailure(repo: RecoverableRepoUtils<any>, type: ZeroAccessDataType, record: any, error: string): Promise<void> {
        this.logger?.warn(`ZeroAccessBackfillJob: leaving ${type} ${record.uid} unsealed: ${error}`);
        try {
            await repo.update(
                { uid: record.uid, version: record.version, zeroAccessBackfillError: error.slice(0, MAX_ERROR_LENGTH) } as any,
                asEntity(repo, record),
                { ignoreACL: true, includeDeleted: true } as any,
            );
        } catch {
            // Selected again next run.
        }
    }

    /** Whether a blob that couldn't be read is still there - the read failed for a reason that passes - or isn't (gone for good once
     * `goneBlobs` confirms it). A store that can't even say is taken to still have it. */
    private async blobExists(key: string): Promise<boolean> {
        try {
            return await this.blobStore!.exists(key);
        } catch {
            return true;
        }
    }

    /** Seals up to `limit` of `mailbox`'s readable messages, newest first, and returns how many it attempted. */
    private async backfillMailbox(mailbox: X, limit: number): Promise<number> {
        // `limit` baked into the query too (SQL reads only that); Outbox is skipped in code, so a few extra rows are asked for. `find()`
        // returns a soft-deleted (restorable) row only for an explicit `deleted: true`, so those - still readable mail at rest - are a
        // second query, after the live ones. Not end-to-end encrypted is `encrypted` false or unset: on SQL, rows stored before the column
        // existed hold NULL, which `ne(true)` (`NOT (encrypted = true)`) never matches, so both are named.
        const pageSize: number = limit + 100;
        const query = (deleted?: true) =>
            this.messageRepo!.find(
                {
                    mailboxUid: mailbox.uid,
                    zeroAccess: null,
                    zeroAccessBackfillError: null,
                    $or: [{ encrypted: ModelUtils.literal(false) }, { encrypted: ModelUtils.literal(null) }],
                    ...(deleted ? { deleted: true } : {}),
                    sort: { receivedDate: "DESC", uid: "ASC" },
                    limit: pageSize,
                } as any,
                { ignoreACL: true, limit: pageSize },
            );
        const candidates: M[] = [...(await query()), ...(await query(true))];
        if (candidates.length === 0) {
            return 0;
        }
        const folders: F[] = await this.folderRepo!.find({ mailboxUid: mailbox.uid, limit: 10_000 } as any, { ignoreACL: true, limit: 10_000 });
        const drafts: Set<string> = new Set(folders.filter((f) => f.type === FolderType.DRAFTS).map((f) => f.uid));
        const outbox: Set<string> = new Set(folders.filter((f) => f.type === FolderType.OUTBOX).map((f) => f.uid));
        const now: number = Date.now();
        let attempted: number = 0;
        for (const message of candidates) {
            if (attempted >= limit) {
                break;
            }
            const inOutbox: boolean = outbox.has(message.folderUid);
            if (message.encrypted || (inOutbox && ZeroAccessBackfillJob.sendPending(message, now, this.deletedScheduledSendDays))) {
                continue;
            }
            attempted++;
            // An Outbox message never relayed is a draft whose send failed: sealed as one, so it can be reopened and sent again.
            const isDraft: boolean = drafts.has(message.folderUid) || (inOutbox && !(message as any).scheduledSendRelayedAt);
            if (!(await this.sealMessage(mailbox, message, isDraft, inOutbox))) {
                // Zero-access stopped being active for this mailbox meanwhile: leave the rest for when it is again.
                break;
            }
        }
        return attempted;
    }

    /**
     * Whether an Outbox message's send can still go ahead: it is due, scheduled or waiting out a retry, or a send holds a live claim. A
     * soft-deleted one isn't sent while deleted (`ScheduledSendJob` doesn't select it) but is again once restored, so its schedule counts
     * until `deletedDays` after the later of its scheduled time and its deletion (`dateModified`, which a soft delete bumps). Not one
     * already relayed whose filing waits for a retry: it has gone out, so nothing is left to send - it is sealed as sent mail at once,
     * keeping its schedule (`sealMessage()`), and a restore still files it.
     */
    private static sendPending(message: Message, now: number, deletedDays: number): boolean {
        const lease: any = (message as any).scheduledSendLeaseExpiresAt;
        if (!!lease && new Date(lease).getTime() > now) {
            return true;
        }
        const scheduledAt: any = message.scheduledSendTime;
        if (!scheduledAt) {
            return false;
        }
        if ((message as any).deleted !== true) {
            return true;
        }
        if ((message as any).scheduledSendRelayedAt) {
            return false;
        }
        const since: number = Math.max(new Date(scheduledAt).getTime() || 0, new Date((message as any).dateModified ?? 0).getTime() || 0);
        return now < since + Math.max(0, Number(deletedDays) || 0) * 86_400_000;
    }

    /**
     * Seals one message, as a draft when `isDraft`; `false` when zero-access is no longer active for its mailbox (nothing was changed). An
     * Outbox message (`inOutbox`) also loses its schedule and lapsed claim: sealed, it is nothing `ScheduledSendJob` could relay - one
     * soft-deleted while scheduled and sealed after `deleted_scheduled_send_days` would otherwise come back due when restored. One already
     * relayed keeps its schedule (a filing retry) and only loses the lapsed claim: `ScheduledSendJob` only files it into Sent Items, sealed
     * as it is, so a restored one is filed.
     */
    private async sealMessage(mailbox: X, message: M, isDraft: boolean, inOutbox: boolean = false): Promise<boolean> {
        let raw: Buffer;
        try {
            raw = await this.blobStore!.get(message.bodyBlobKey);
            this.goneBlobs.forget(message.bodyBlobKey);
        } catch (err: any) {
            if (await this.blobExists(message.bodyBlobKey)) {
                this.logger?.warn(`ZeroAccessBackfillJob: message ${message.uid}'s body couldn't be read this run: ${err?.message ?? err}`);
            } else if (!this.goneBlobs.confirmed(message.bodyBlobKey)) {
                this.logger?.warn(`ZeroAccessBackfillJob: message ${message.uid}'s body isn't there; left until it has been missing for a while.`);
            } else {
                await this.recordFailure(message, `The message body couldn't be read: ${err?.message ?? err}`);
            }
            return true;
        }
        let sealed: ZeroAccessSealedFields | undefined;
        try {
            const receivedAt: Date = new Date(message.receivedDate ?? message.sentDate ?? Date.now());
            // A draft's index entry is written only once its sealed row has won (`writeDraftIndex()`).
            sealed = isDraft
                ? await this.zeroAccessWriter!.sealDraft(mailbox, raw, message.uid, receivedAt, { deferIndex: true })
                : await this.zeroAccessWriter!.sealRaw(mailbox, raw, message.uid, receivedAt);
        } catch (err: any) {
            // Even a message that can't be parsed is sealed (`sealRaw()`): storing the sealed copy or its index entry fails only for a while.
            this.logger?.warn(`ZeroAccessBackfillJob: message ${message.uid} couldn't be sealed this run: ${err?.message ?? err}`);
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
                    ...(inOutbox
                        ? (message as any).scheduledSendRelayedAt
                            ? { scheduledSendLeaseExpiresAt: null }
                            : { scheduledSendTime: null, scheduledSendAttempts: null, scheduledSendLeaseExpiresAt: null }
                        : {}),
                    // Indexed again, now as metadata only: the server-side search document still holds the readable text. Retries
                    // included (`SEARCH_REINDEX`): a message whose indexing retries had run out is otherwise never selected again.
                    ...SEARCH_REINDEX,
                } as any,
                asEntity(this.messageRepo!, message),
                { ignoreACL: true, includeDeleted: true } as any,
            );
        } catch (err: any) {
            // Changed meanwhile (a move, a flag, a compose save, another replica's seal): the next run picks it up again if it is still
            // readable. A draft's fresh blob isn't the message's; its index entry was never written, so the winner's stands.
            if (isDraft) {
                await this.blobStore!.delete(sealed.bodyBlobKey).catch(() => undefined);
            }
            this.logger?.debug?.(`ZeroAccessBackfillJob: message ${message.uid} changed while it was sealed; retrying later: ${err?.message}`);
            return true;
        }
        if (isDraft) {
            await this.writeDraftIndex(message, sealed);
        }
        try {
            // A draft keeps its attachment rows: they are its working attachments, which the compose window lists and its send is built from.
            if (isDraft) {
                await this.zeroAccessWriter!.discardDraftPlaintext(this.blobRepos, message.uid, previous);
            } else {
                await this.zeroAccessWriter!.discardPlaintext(this.blobRepos, message.uid, previous);
            }
        } catch (err: any) {
            this.logger?.warn(`ZeroAccessBackfillJob: message ${message.uid} is sealed but its readable copies couldn't all be removed: ${err?.message}`);
        }
        if ((message as any).deleted === true) {
            // At once, best effort (logged): `SearchIndexJob` replaces it with the metadata document on its pass over sealed soft-deleted
            // mail (the stamp is null), retrying until that is written or the document is gone, so a failure here is caught up.
            await removeFromSearchIndex(this.searchProvider, "message", message.uid, this.logger);
        }
        return true;
    }

    /**
     * Writes the index entry of a draft whose sealed row was just stored (`sealDraft()`'s deferred `writeIndex()`), replacing the one it
     * had. Not when the row no longer points at this seal's blob - a compose save after it wrote its own entry - or can't be read.
     * Best effort (logged): a draft left without an entry gets one at its next save or when it is sent.
     */
    private async writeDraftIndex(message: M, sealed: ZeroAccessSealedFields): Promise<void> {
        try {
            const current: M | undefined = await this.messageRepo!.findOne(message.uid, { ignoreACL: true, includeDeleted: true, skipCache: true });
            if (current?.bodyBlobKey === sealed.bodyBlobKey) {
                await sealed.writeIndex?.();
            }
        } catch (err: any) {
            this.logger?.warn(`ZeroAccessBackfillJob: draft ${message.uid} is sealed but its index entry couldn't be written: ${err?.message ?? err}`);
        }
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
