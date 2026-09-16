///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, NotificationUtils, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { boundIndexedValue } from "../util/ConversationUtils.js";
import { asEntity } from "../util/EntityUtils.js";
import { BlobStore } from "../blob/BlobStore.js";
import { ScanPipeline } from "../scan/ScanPipeline.js";
import { normalizeAddress } from "../util/AddressUtils.js";
import { findOrCreateWellKnownFolder } from "../util/FolderUtils.js";
import { scanAndRelay } from "../util/MailSendUtils.js";
import { deriveMessageListFields } from "../util/MessageListUtils.js";
import { checkOriginatorHeaders, extractHeader, prependHeaders } from "../util/MimeHeaderUtils.js";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
import { FolderType, Mailbox, Message } from "../models/types.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;

/** Maximum length of a persisted `scheduledSendError`. */
const MAX_ERROR_LENGTH = 1000;

/**
 * Polls `Message` rows whose `scheduledSendTime` (set by `BaseMessageRoute.send()`'s deferred-send branch - see
 * its own doc comment) is now due, relays each one via the same `scanAndRelay()` gate an immediate send uses,
 * then moves it into the mailbox's Sent Items folder and clears `scheduledSendTime` - mirroring exactly what
 * `send()` itself does for a message with no deferred send time.
 *
 * `relayDueMessage()` claims a message (a version-checked lease pushing `scheduledSendTime` forward) before doing any
 * relay/side-effecting work, the same "claim first, work second" discipline `DataExportJob.
 * processRequest()` uses - see that method's own doc comment for why: without it, a concurrent cancel/edit
 * of the same message could race the actual SMTP send, resulting in a delivered email the DB ends up
 * reflecting as cancelled.
 *
 * Guards applied before a message is ever relayed (a due `scheduledSendTime` alone is not enough, since it is
 * an ordinary client-writable field):
 * - The message must sit in its own mailbox's `OUTBOX` folder - the only place `send()` stages a deferred send.
 * - It must have at least one To/Cc/Bcc recipient address (otherwise it is refused, not retried).
 * - `from.address` must be one of the owning mailbox's own addresses (`primarySmtpAddress`/
 * `aliasAddresses`, case-insensitive).
 * - Every address in the stored MIME's `From`/`Sender` headers must be one of those addresses too, with at most one
 * of each header, and no address in a display name or comment (`checkOriginatorHeaders()` with
 * `rejectAddressLikeDisplayNames`, run on the exact bytes about to be relayed).
 * A message failing any guard is taken out of the due queue unsent (`scheduledSendTime` cleared,
 * `scheduledSendError` set) so it can never block the queue.
 *
 * Failure handling:
 * - Relay failure (the transport never accepted it): `scheduledSendAttempts` is incremented and
 * `scheduledSendTime` is pushed forward by `attempts x retry_backoff_ms`, which also moves it behind other due
 * messages in the (stably sorted) queue. After `max_attempts` it is left unsent with `scheduledSendError` set
 * and `scheduledSendTime` cleared.
 * - Failure AFTER the transport accepted it (e.g. filing into Sent Items): the message is never relayed again.
 * `scheduledSendRelayedAt` is stamped on its own the moment the transport accepts (before any other write), and the
 * next run only finishes filing (subject to the same attempts/backoff budget).
 *
 * Filing into Sent Items only happens while the run's claim still stands - the message is still in the Outbox it was
 * claimed in, carrying that claim's `scheduledSendLeaseExpiresAt` - and does nothing otherwise.
 *
 * Concrete entity classes are supplied by the Mongo/SQL subclasses (`ScheduledSendJobMongo`/
 * `ScheduledSendJobSQL`), following the same generic pattern `CalendarReminderJob` uses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class ScheduledSendJob<M extends Message> extends BackgroundService {
    protected abstract messageClass: any;
    protected abstract folderClass: any;
    protected abstract mailboxClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private messageRepo?: RecoverableRepoUtils<M>;
    private folderRepo?: RecoverableRepoUtils<any>;
    private mailboxRepo?: RepoUtils<Mailbox>;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    @Inject("MailTransport")
    private mailTransport?: any;

    @Inject(ScanPipeline)
    private scanPipeline?: ScanPipeline;

    @Inject(NotificationUtils)
    private notificationUtils?: NotificationUtils;

    @Config("mail:jobs:scheduled_send:schedule", "*/30 * * * * *")
    private scheduleExpr: string = "*/30 * * * * *";

    @Config("mail:jobs:scheduled_send:batch_size", 50)
    private batchSize: number = 50;

    @Config("mail:jobs:scheduled_send:max_attempts", 5)
    private maxAttempts: number = 5;

    @Config("mail:jobs:scheduled_send:retry_backoff_ms", 60_000)
    private retryBackoffMs: number = 60_000;

    /** How far a claim pushes `scheduledSendTime` ahead while a relay is in flight (see `relayDueMessage()`). */
    @Config("mail:jobs:scheduled_send:lease_ms", 900_000)
    private leaseMs: number = 900_000;

    @Logger
    private logger: any;

    public get schedule(): string | undefined {
        return this.scheduleExpr;
    }

    @Init
    public async init(): Promise<void> {
        this.messageRepo = await this._objectFactory!.newInstance(RecoverableRepoUtils, {
            name: this.messageClass.name,
            args: [this.messageClass],
        });
        this.folderRepo = await this._objectFactory!.newInstance(RecoverableRepoUtils, {
            name: this.folderClass.name,
            args: [this.folderClass],
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
        if (!this.messageRepo) {
            return;
        }

        const now: Date = new Date();
        // `limit` must be passed both via `options` (used by the Mongo backend) *and* baked into the query
        // object itself, matching every other job's own documented note on `ModelUtils.buildSearchQuerySQL`
        // ignoring `options.limit` on the SQL backend. Sorted (with `uid` as a tiebreaker for a stable order)
        // so the oldest-due messages are always processed first; a failing message's backoff pushes its
        // `scheduledSendTime` forward, moving it behind the rest of the queue rather than pinning the batch.
        const due: M[] = await this.messageRepo.find(
            {
                scheduledSendTime: `lte(${now.toISOString()})`,
                limit: this.batchSize,
                sort: { scheduledSendTime: "ASC", uid: "ASC" },
            } as any,
            { ignoreACL: true, limit: this.batchSize },
        );

        for (const message of due) {
            try {
                await this.relayDueMessage(message);
            } catch (err: any) {
                this.logger?.warn(`ScheduledSendJob: failed to relay scheduled message ${message.uid}: ${err.message}`);
            }
        }
    }

    /** `null`, not `undefined`, is used throughout to clear fields: TypeORM's `Repository.update()` silently
     * skips an `undefined` property (leaving the SQL column unchanged) but does set an explicit `null` to NULL -
     * the Mongo backend's `$set` handles both the same way, so `null` is the one value that reliably clears a
     * field on both backends.
     *
     * Every value written here that came out of the relayed MIME (`messageId`, `conversationId`) goes through
     * `boundIndexedValue()`: `RepoUtils.update()` writes a patch without running the model constructor (which is where
     * the bounding normally happens), and an over-long value would fail the write on MySQL/MariaDB `varchar(255)`. */
    private async relayDueMessage(message: M): Promise<void> {
        const dueAt: any = (message as any).scheduledSendTime;
        const alreadyRelayed: boolean = !!(message as any).scheduledSendRelayedAt;

        const validation = await this.validateForRelay(message, alreadyRelayed);
        if (validation.refusal) {
            await this.refuse(message, validation.refusal);
            return;
        }
        const ownAddresses: Set<string> = validation.ownAddresses ?? new Set();

        // Claimed via a version-checked update BEFORE any relay/side-effecting work happens - the same "claim
        // first, work second" discipline `DataExportJob.processRequest()` uses. Without this, `scanAndRelay()`
        // below (an irreversible external SMTP send) could run against a message a concurrent cancel/edit has
        // already superseded. Claiming first means whichever side's version is stale loses cleanly: if a
        // cancel/edit already bumped the version by the time this runs, this claim itself throws immediately and
        // nothing below - `scanAndRelay()` included - ever runs.
        //
        // The claim is a *lease*, not a clear: `scheduledSendTime` is pushed `lease_ms` into the future, so the row
        // drops out of the due query while this run works on it, but a process crash mid-relay leaves it due again
        // once the lease expires instead of silently losing the send. `scheduledSendLeaseExpiresAt` (the same instant)
        // is the in-flight marker: while it's in the future `BaseMessageRoute` refuses to move the message out of
        // Outbox, so a user can't cancel a send that is already on the wire and then send it a second time. `lease_ms`
        // must comfortably exceed a relay's worst-case duration, or another replica could re-claim an in-flight send.
        const leaseExpiresAt: Date = new Date(Date.now() + Number(this.leaseMs));
        const claimed: M = await this.messageRepo!.update(
            {
                uid: message.uid,
                version: (message as any).version,
                scheduledSendTime: leaseExpiresAt,
                scheduledSendLeaseExpiresAt: leaseExpiresAt,
            } as any,
            asEntity(this.messageRepo!, message),
            { ignoreACL: true },
        );

        let raw: Buffer | undefined;
        let relayedRaw: Buffer | undefined;
        let messageId: string | undefined = claimed.messageId || undefined;
        let conversationId: string | undefined = (claimed as any).conversationId ?? undefined;
        let sanitizedHtmlBlobKey: string | undefined = (claimed as any).sanitizedHtmlBlobKey ?? undefined;
        let relayedAt: Date | undefined = alreadyRelayed ? new Date((claimed as any).scheduledSendRelayedAt) : undefined;

        if (!alreadyRelayed) {
            // Wraps the transport so a failure *after* the transport accepted the message (inside
            // `scanAndRelay()` itself, e.g. storing the sanitized HTML blob) is still recognized as "relayed" and
            // never retried as a fresh send - and so the relayed marker is persisted the moment the transport accepts,
            // before any other write that could fail.
            const trackingTransport = {
                send: async (outbound: any) => {
                    const result: any = await this.mailTransport.send(outbound);
                    if (result && (result.accepted ?? []).length > 0) {
                        relayedRaw = outbound.raw;
                        relayedAt = new Date();
                        await this.recordRelayed(claimed, relayedAt);
                    }
                    return result;
                },
            };
            try {
                raw = await this.blobStore!.get(claimed.bodyBlobKey);
                // The stored MIME's own originator headers are what recipients actually see - `from.address` alone
                // (checked in `validateForRelay()`) says nothing about them. Checked on the exact bytes relayed
                // below, so a concurrent blob rewrite can't slip past between check and send. Same rules as
                // `BaseMessageRoute.send()`, display names included.
                const headerRefusal: string | undefined = checkOriginatorHeaders(raw, (address) => ownAddresses.has(normalizeAddress(address)), {
                    rejectAddressLikeDisplayNames: true,
                });
                if (headerRefusal) {
                    await this.refuse(claimed, headerRefusal);
                    return;
                }
                const envelopeTo: string[] = claimed.recipients.map((r) => r.address);
                const result = await scanAndRelay(
                    raw,
                    claimed.from.address,
                    envelopeTo,
                    this.scanPipeline!,
                    trackingTransport,
                    this.blobStore!,
                );
                relayedRaw = result.raw;
                messageId = result.messageId;
                conversationId = result.conversationId;
                sanitizedHtmlBlobKey = result.sanitizedHtmlBlobKey ?? sanitizedHtmlBlobKey;
            } catch (err: any) {
                if (!relayedAt) {
                    await this.recordFailedAttempt(claimed, dueAt, err, {});
                    throw err;
                }
                const injectedId: string | undefined = relayedRaw ? extractHeader(relayedRaw, "Message-ID") : undefined;
                if (injectedId) {
                    messageId = injectedId.replace(/^</, "").replace(/>$/, "");
                }
                this.logger?.warn(
                    `ScheduledSendJob: message ${claimed.uid} was relayed but post-relay processing failed: ${err.message}`,
                );
            }
        }

        try {
            // Re-fetched rather than reusing `claimed`'s own version - the relay above can take long
            // enough that trusting a version fetched before it risks a spurious conflict against a
            // completely unrelated concurrent write to this same row (e.g. the user separately marking it
            // read), mirroring `DataExportJob.processRequest()`'s identical final-transition re-fetch.
            const refetched: M | undefined = await this.messageRepo!.findOne(claimed.uid, { ignoreACL: true });
            // Filed only while this run's claim still stands: the message is still in the Outbox it was claimed in and
            // still carries this claim's lease. Otherwise another claim took it over (a lapsed lease) or it was moved
            // after the lease lapsed - either way it's no longer this run's to file, and nothing is written.
            if (!refetched || !this.stillClaimed(refetched, claimed)) {
                this.logger?.warn(`ScheduledSendJob: not filing message ${claimed.uid} - it is no longer in Outbox under this run's claim.`);
                return;
            }

            if (relayedRaw && relayedRaw !== raw) {
                // See the identical comment in `BaseMessageRoute.send()` - keeps the stored blob consistent
                // with what was actually relayed whenever `scanAndRelay()` had to inject a missing Message-ID.
                await this.blobStore!.put(claimed.bodyBlobKey, relayedRaw, { contentType: "message/rfc822" });
            } else if (alreadyRelayed && messageId) {
                // Finishing a previous run's filing: that run may have failed before persisting an injected
                // Message-ID into the stored blob - re-apply the same header `scanAndRelay()` prepended.
                const stored: Buffer = await this.blobStore!.get(claimed.bodyBlobKey);
                if (!extractHeader(stored, "Message-ID")) {
                    await this.blobStore!.put(claimed.bodyBlobKey, prependHeaders(stored, [{ name: "Message-ID", value: `<${messageId}>` }]), {
                        contentType: "message/rfc822",
                    });
                }
            }

            const sentFolder: any = await findOrCreateWellKnownFolder(
                this.folderRepo!,
                this.folderClass,
                claimed.mailboxUid,
                FolderType.SENT_ITEMS,
            );
            const flags = { ...refetched.flags, read: true };

            const updated: M = await this.messageRepo!.update(
                {
                    uid: refetched.uid,
                    version: (refetched as any).version,
                    folderUid: sentFolder.uid,
                    flags,
                    // An update is a patch, not a constructed entity, so `flags`' denormalized list mirrors have
                    // to be re-derived alongside it - see `util/MessageListUtils.ts`.
                    ...deriveMessageListFields({ ...refetched, flags }),
                    sanitizedHtmlBlobKey: sanitizedHtmlBlobKey ?? null,
                    ...(messageId ? { messageId: boundIndexedValue(messageId) } : {}),
                    conversationId: boundIndexedValue(conversationId) ?? null,
                    // Releases the claim's lease.
                    scheduledSendTime: null,
                    scheduledSendLeaseExpiresAt: null,
                    scheduledSendAttempts: null,
                    scheduledSendError: null,
                    scheduledSendRelayedAt: null,
                } as any,
                asEntity(this.messageRepo!, refetched),
                { ignoreACL: true },
            );
            this.notificationUtils?.sendMessage(sentFolder.uid, this.messageClass.name, "update", updated);
        } catch (err: any) {
            // The message WAS relayed - never restore it as a fresh send. Stamp the relayed marker (plus what the
            // relay produced) so the next run only finishes filing.
            await this.recordFailedAttempt(claimed, dueAt, err, {
                scheduledSendRelayedAt: relayedAt,
                ...(messageId ? { messageId: boundIndexedValue(messageId) } : {}),
                conversationId: boundIndexedValue(conversationId) ?? null,
                sanitizedHtmlBlobKey: sanitizedHtmlBlobKey ?? null,
            });
            throw err;
        }
    }

    /** Whether `current` is still in the Outbox `claimed` was claimed in, carrying the lease that claim wrote. */
    private stillClaimed(current: M, claimed: M): boolean {
        const lease = (row: M): number | undefined => {
            const value: any = (row as any).scheduledSendLeaseExpiresAt;
            const time: number = value ? new Date(value).getTime() : NaN;
            return Number.isNaN(time) ? undefined : time;
        };
        return current.folderUid === claimed.folderUid && lease(claimed) !== undefined && lease(current) === lease(claimed);
    }

    /**
     * Persists `scheduledSendRelayedAt` on its own, the moment the transport accepted `claimed` - one minimal
     * version-checked write, re-read and retried when an unrelated write (e.g. a flag change) bumped the version first.
     * Nothing else goes into this write, so nothing else (an over-long header value, a blob store hiccup) can stop the
     * marker landing and let a later run relay the message again. Best-effort: a failure is logged, and the filing path
     * stamps the marker again.
     */
    private async recordRelayed(claimed: M, relayedAt: Date): Promise<void> {
        let current: M | undefined = claimed;
        for (let attempt = 1; current && attempt <= 3; attempt++) {
            if ((current as any).scheduledSendRelayedAt) {
                return;
            }
            try {
                await this.messageRepo!.update(
                    { uid: current.uid, version: (current as any).version, scheduledSendRelayedAt: relayedAt } as any,
                    asEntity(this.messageRepo!, current),
                    { ignoreACL: true },
                );
                return;
            } catch (err: any) {
                this.logger?.warn(`ScheduledSendJob: failed to record the relay of message ${claimed.uid} (attempt ${attempt}): ${err.message}`);
                // Soft-deleted rows included: a message deleted mid-relay still gets its marker, so a restore can't
                // make it due for a second relay.
                current = attempt < 3 ? await this.messageRepo!.findOne(claimed.uid, { ignoreACL: true, includeDeleted: true }) : undefined;
            }
        }
    }

    /** Takes `message` out of the due queue unsent with `reason` recorded. Version-checked, so a concurrent edit
     * (e.g. the user moving it into Outbox properly) wins. */
    private async refuse(message: M, reason: string): Promise<void> {
        await this.messageRepo!.update(
            {
                uid: message.uid,
                version: (message as any).version,
                scheduledSendTime: null,
                scheduledSendLeaseExpiresAt: null,
                scheduledSendAttempts: null,
                scheduledSendError: reason,
            } as any,
            asEntity(this.messageRepo!, message),
            { ignoreACL: true },
        );
        this.logger?.warn(`ScheduledSendJob: refusing to send scheduled message ${message.uid}: ${reason}`);
    }

    /** Returns a refusal reason if `message` must not be relayed (or, with `folderOnly` - an already-relayed message
     * that only needs filing - must not be filed); otherwise the sending mailbox's own (normalized) addresses, for the
     * stored MIME's originator-header check. */
    private async validateForRelay(message: M, folderOnly: boolean = false): Promise<{ refusal?: string; ownAddresses?: Set<string> }> {
        const folder: any = message.folderUid
            ? await this.folderRepo!.findOne(message.folderUid, { ignoreACL: true })
            : undefined;
        if (!folder || folder.type !== FolderType.OUTBOX || folder.mailboxUid !== message.mailboxUid) {
            return { refusal: "Message is not in its mailbox's Outbox folder." };
        }
        if (folderOnly) {
            return {};
        }

        const mailbox: Mailbox | undefined = await this.mailboxRepo!.findOne(message.mailboxUid, { ignoreACL: true });
        if (!mailbox) {
            return { refusal: "The sending mailbox no longer exists." };
        }
        const ownAddresses: Set<string> = new Set(
            [mailbox.primarySmtpAddress, ...(mailbox.aliasAddresses ?? [])].filter((a) => typeof a === "string" && !!a).map((a) => normalizeAddress(a)),
        );
        if (!(Array.isArray(message.recipients) && message.recipients.some((r) => typeof r?.address === "string" && r.address.trim().length > 0))) {
            return { refusal: "The message has no To, Cc or Bcc recipients." };
        }
        const fromAddress: string = message.from?.address ? normalizeAddress(message.from.address) : "";
        if (!fromAddress || !ownAddresses.has(fromAddress)) {
            return { refusal: "The From address is not one of the sending mailbox's own addresses." };
        }
        return { ownAddresses };
    }

    /**
     * Records a failed attempt on an already-claimed message: increments `scheduledSendAttempts` and either
     * re-queues it with linear backoff (`scheduledSendTime = now + attempts x retryBackoffMs`) or, once
     * `maxAttempts` is reached, leaves it out of the queue with `scheduledSendError` set. Best-effort: a failure
     * here is logged, and the message is simply retried once the claim's lease expires. Also releases the claim
     * (`scheduledSendLeaseExpiresAt`), and does nothing once the message is no longer under `claimed`'s claim.
     */
    private async recordFailedAttempt(claimed: M, dueAt: any, err: any, extra: Record<string, any>): Promise<void> {
        const uid: string = claimed.uid;
        try {
            const current: M | undefined = await this.messageRepo!.findOne(uid, { ignoreACL: true });
            if (!current || !this.stillClaimed(current, claimed)) {
                return;
            }
            const attempts: number = ((current as any).scheduledSendAttempts ?? 0) + 1;
            const reason: string = String(err?.message ?? err).slice(0, MAX_ERROR_LENGTH);
            const exhausted: boolean = attempts >= this.maxAttempts;
            const nextAttemptAt: Date = new Date(Math.max(Date.now(), new Date(dueAt).getTime() || 0) + attempts * this.retryBackoffMs);
            await this.messageRepo!.update(
                {
                    uid: current.uid,
                    version: (current as any).version,
                    ...extra,
                    scheduledSendTime: exhausted ? null : nextAttemptAt,
                    scheduledSendLeaseExpiresAt: null,
                    // Reset once exhausted so a later, user-initiated reschedule starts with a fresh budget.
                    scheduledSendAttempts: exhausted ? null : attempts,
                    scheduledSendError: exhausted ? `Gave up after ${attempts} attempts: ${reason}` : reason,
                } as any,
                asEntity(this.messageRepo!, current),
                { ignoreACL: true },
            );
            if (exhausted) {
                this.logger?.error(`ScheduledSendJob: giving up on scheduled message ${uid} after ${attempts} attempts: ${reason}`);
            }
        } catch (updateErr: any) {
            this.logger?.warn(`ScheduledSendJob: failed to record a failed attempt for ${uid}: ${updateErr.message}`);
        }
    }
}
