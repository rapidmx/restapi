///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, NotificationUtils, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { boundIndexedValue, findThreadConversationId, resolveConversationId } from "../util/ConversationUtils.js";
import { asEntity } from "../util/EntityUtils.js";
import { refreshFolderCounts } from "../util/FolderCountUtils.js";
import type { TransportError, TransportFailure } from "../transport/MailTransport.js";
import { isPermanentRelayFailure, type MailRelayFailureDetails } from "../transport/TransportResultUtils.js";
import type { DnsResolver } from "../dns/DnsResolver.js";
import {
    type DeliveryNoticeSink,
    deliveryFailureKey,
    describeOriginal,
    tryFileDeliveryFailureNotice,
} from "../util/DeliveryFailureNoticeUtils.js";
import { BlobStore } from "../blob/BlobStore.js";
import { ScanPipeline } from "../scan/ScanPipeline.js";
import { normalizeAddress } from "../util/AddressUtils.js";
import { findOrCreateWellKnownFolder } from "../util/FolderUtils.js";
import { prepareOutboundMime, scanAndRelay, seedReceiptStatus } from "../util/MailSendUtils.js";
import { deriveMessageListFields } from "../util/MessageListUtils.js";
import { checkOriginatorHeaders, extractHeader, prependHeaders } from "../util/MimeHeaderUtils.js";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
import { FolderType, Mailbox, Message } from "../models/types.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;

/** Maximum length of a persisted `scheduledSendError`. */
const MAX_ERROR_LENGTH = 1000;

/** What a send attempt came to - the `action` of the event `ScheduledSendJob` publishes. */
export type SendEventAction = "send-succeeded" | "send-failed" | "send-retrying";

/**
 * The `data` of a `send-succeeded` / `send-failed` / `send-retrying` event: `{ type: <the Message class name>, action, data }`,
 * published on the sending mailbox's uid channel and on the Outbox (and, once filed, Sent Items) folder channels.
 */
export interface SendEventData {
    uid: string;
    mailboxUid: string;
    subject: string;
    /** Every To, Cc and Bcc address. */
    recipients: string[];
    /** Which attempt this is about, counting from 1: the one that succeeded, the one that failed. */
    attempt: number;
    /** `send-retrying` only: when the next attempt is due. */
    nextAttemptAt?: string;
    /** `send-failed` and `send-retrying`: why. `details` is what the mail system said (per-recipient SMTP status, its error), when it said anything. */
    error?: { message: string; details?: MailRelayFailureDetails };
}

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
 * - Either way - a message refused above, or one given up on - the sender is told: a delivery failure notice (see
 * `util/DeliveryFailureNoticeUtils.ts`) with everything the mail system said is filed in the sending mailbox's Inbox,
 * once, after the write that took the message out of the queue succeeds. The same goes for a message the transport relayed
 * to only some of its recipients: the ones it refused are reported. Notices are best-effort (a failure to file one is logged
 * and never changes what happens to the message).
 * - Failure AFTER the transport accepted it (e.g. filing into Sent Items): the message is never relayed again.
 * `scheduledSendRelayedAt` is stamped on its own the moment the transport accepts (before any other write), and the
 * next run only finishes filing (subject to the same attempts/backoff budget).
 *
 * Filing into Sent Items only happens while the run's claim still stands - the message is still in the Outbox it was
 * claimed in, carrying that claim's `scheduledSendLeaseExpiresAt` - and does nothing otherwise.
 *
 * Background send (`POST /messages/:id/send` with `{ background: true }`): the route moves the message into Outbox, due now, answers
 * 202 and calls `enqueue()` - so this job relays it at once, in this process, a bounded number at a time
 * (`mail:jobs:scheduled_send:concurrency`), instead of at the next scheduled run. Nothing else changes: the message is an ordinary
 * due message in Outbox, so a process that dies before, during or after the relay leaves it for the next run - and `start()`
 * sweeps at once - to finish, with the claim and the relayed marker below keeping it from being sent twice.
 *
 * Every outcome is published as an event `{ type: <Message class name>, action, data: SendEventData }` on the mailbox's uid
 * channel and the Outbox/Sent Items folder channels: `send-succeeded` when it is filed in Sent Items, `send-retrying` (with
 * `nextAttemptAt`) when an attempt failed and another is due, `send-failed` when it will not be tried again - refused, given up
 * on after `max_attempts`, or failed for a reason no retry can fix (spam/malware verdict, every recipient refused with an SMTP
 * 5xx: `isPermanentRelayFailure()`). A message that fails for good stays in Outbox with `scheduledSendError` set and nothing due
 * (the sender's Inbox gets the delivery failure notice); the user moves it back to Drafts, or sends it again, which starts a
 * fresh retry budget.
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

    /** The `Domain` class, for classifying recipients when a receipt is requested. Without it no receipt is requested. */
    protected domainClass?: any;

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

    @Inject("DnsResolver")
    private dnsResolver?: DnsResolver;

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

    /** How many relays run at once for background sends and scheduled runs together. */
    @Config("mail:jobs:scheduled_send:concurrency", 4)
    private concurrency: number = 4;

    /** How long `stop()` waits for relays in flight to finish. */
    @Config("mail:jobs:scheduled_send:drain_ms", 15_000)
    private drainMs: number = 15_000;

    @Logger
    private logger: any;

    /** The messages being relayed or waiting for a slot, by uid - so nothing is worked on twice in this process. */
    private readonly pending: Map<string, Promise<void>> = new Map();

    private active: number = 0;

    private readonly slotWaiters: Array<() => void> = [];

    private stopping: boolean = false;

    /** The startup sweep, so `whenIdle()` covers it too. */
    private sweeping?: Promise<void>;

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

    /** Sweeps once, without waiting: whatever a process that died left due or half-finished (a background send queued but not
     * yet relayed, a relay accepted but not filed) is finished now rather than at the next scheduled run. */
    public async start(): Promise<void> {
        this.stopping = false;
        this.sweeping = this.run().catch((err: any) => {
            this.logger?.warn(`ScheduledSendJob: the startup sweep failed: ${err?.message}`);
        });
    }

    /** Stops taking new work and waits (up to `drain_ms`) for the relays in flight, so a shutdown does not cut one off. */
    public async stop(): Promise<void> {
        this.stopping = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                this.whenIdle(),
                new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, Number(this.drainMs));
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    /** Resolves once nothing is being relayed or waiting to be. */
    public async whenIdle(): Promise<void> {
        await this.sweeping;
        while (this.pending.size > 0) {
            await Promise.allSettled([...this.pending.values()]);
        }
    }

    /**
     * Relays the message `uid` now if it is due - what a background send does after answering 202. Returns at once with a
     * promise for when it is done (never rejecting: a failure is recorded on the message, logged and published as an event).
     * A message already being relayed here is not started twice, one that is not due (cancelled since, or waiting for a
     * time) is left alone, and after `stop()` nothing new starts - the message stays due for the next process.
     */
    public enqueue(uid: string): Promise<void> {
        if (this.stopping || !this.messageRepo) {
            return Promise.resolve();
        }
        return this.track(uid, async () => {
            const message: M | undefined = await this.messageRepo!.findOne(uid, { ignoreACL: true, skipCache: true });
            const dueAt: number = message?.scheduledSendTime ? new Date(message.scheduledSendTime).getTime() : NaN;
            if (message && dueAt <= Date.now()) {
                await this.relayDueMessage(message);
            }
        });
    }

    /** Runs `work` for `uid` in one of the `concurrency` slots, unless `uid` is already being worked on (then that work is what is awaited). */
    private track(uid: string, work: () => Promise<void>): Promise<void> {
        const existing: Promise<void> | undefined = this.pending.get(uid);
        if (existing) {
            return existing;
        }
        const promise: Promise<void> = this.withSlot(work)
            .catch((err: any) => {
                this.logger?.warn(`ScheduledSendJob: failed to relay scheduled message ${uid}: ${err?.message}`);
            })
            .finally(() => {
                this.pending.delete(uid);
            });
        this.pending.set(uid, promise);
        return promise;
    }

    /** How many relays may run at once: `mail:jobs:scheduled_send:concurrency`, less if the datastore cannot take more. */
    protected maxParallel(): number {
        return Math.max(1, Number(this.concurrency));
    }

    private async withSlot(work: () => Promise<void>): Promise<void> {
        if (this.active >= this.maxParallel()) {
            // The slot is handed over by whoever finishes, so `active` is never decremented in between.
            await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
        } else {
            this.active++;
        }
        try {
            await work();
        } finally {
            const next: (() => void) | undefined = this.slotWaiters.shift();
            if (next) {
                next();
            } else {
                this.active--;
            }
        }
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

        // One at a time, oldest first - through the same slots and de-duplication as `enqueue()`, so a message a background send
        // has just started is waited for, not relayed a second time.
        for (const message of due) {
            await this.track(message.uid, () => this.relayDueMessage(message));
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
        const sendingMailbox: Mailbox | undefined = validation.mailbox;
        const attemptNumber: number = ((message as any).scheduledSendAttempts ?? 0) + 1;

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
        let undelivered: MailRelayFailureDetails | undefined;
        let relayInfo: { encrypted: boolean; inReplyTo?: string; references: string[] } | undefined;
        let attachesReceiptRequest: boolean = false;

        if (!alreadyRelayed) {
            // Wraps the transport so a failure *after* the transport accepted the message (inside
            // `scanAndRelay()` itself, e.g. storing the sanitized HTML blob) is still recognized as "relayed" and
            // never retried as a fresh send - and so the relayed marker is persisted the moment the transport accepts,
            // before any other write that could fail.
            const trackingTransport = {
                name: this.mailTransport.name,
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
                // The receipt request and encryption-key announcement an immediate send adds (`prepareOutboundMime()`).
                const prepared = await prepareOutboundMime({
                    raw,
                    message: claimed,
                    mailbox: sendingMailbox,
                    objectFactory: this._objectFactory!,
                    domainClass: this.domainClass,
                    dnsResolver: this.dnsResolver,
                });
                attachesReceiptRequest = prepared.attachesReceiptRequest;
                const result = await scanAndRelay(
                    prepared.raw,
                    claimed.from.address,
                    envelopeTo,
                    this.scanPipeline!,
                    trackingTransport,
                    this.blobStore!,
                );
                relayedRaw = result.raw;
                relayInfo = { encrypted: result.encrypted, inReplyTo: result.inReplyTo, references: result.references };
                messageId = result.messageId;
                // The conversation this mailbox already files the message being replied to under, falling back to
                // what the relayed headers derive on their own - the same resolution `BaseMessageRoute.send()`
                // applies to an immediate send, so a scheduled reply threads identically to an immediate one.
                conversationId = await resolveConversationId(result.references, result.inReplyTo, result.messageId, (ancestors) =>
                    findThreadConversationId(this.messageRepo!, claimed.mailboxUid, ancestors),
                );
                sanitizedHtmlBlobKey = result.sanitizedHtmlBlobKey ?? sanitizedHtmlBlobKey;
                undelivered = result.undelivered;
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

        if (undelivered) {
            await this.reportUndelivered(claimed, deliveryFailureKey("scheduled-partial", claimed.uid), undelivered, {
                messageId,
                reason: "The mail system accepted this message for some of its recipients but refused these.",
            });
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
                    // What the relayed bytes say (only known to the run that relayed them): the threading headers recipients
                    // received, whether the body is S/MIME encrypted, and the receipts to track - as an immediate send files them.
                    ...(relayInfo
                        ? {
                              encrypted: relayInfo.encrypted,
                              inReplyTo: relayInfo.inReplyTo ?? (refetched as any).inReplyTo ?? null,
                              references: relayInfo.references.length > 0 ? relayInfo.references : ((refetched as any).references ?? []),
                          }
                        : {}),
                    ...(attachesReceiptRequest ? { receiptStatus: seedReceiptStatus(claimed.recipients.map((r) => r.address)) } : {}),
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
            this.publishSendEvent("send-succeeded", refetched, [refetched.folderUid, sentFolder.uid], { attempt: attemptNumber });
            // Outbox -> Sent Items: both folders' counts changed.
            await refreshFolderCounts(this.noticeSink(), [refetched.folderUid, sentFolder.uid]);
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

    /** What an event says about a failure: a message the transport had already accepted was delivered and only its filing failed. */
    private eventErrorMessage(reason: string, extra: Record<string, any>): string {
        return extra.scheduledSendRelayedAt ? `The message was sent, but could not be filed in Sent Items: ${reason}` : reason;
    }

    /**
     * Publishes a `SendEventData` (`{ type: <Message class name>, action, data }`) once, on the sending mailbox's uid channel and on
     * each of `folderUids` - the Outbox, and Sent Items once it is filed - so a client subscribed to either sees it.
     * Best-effort: a publish failure is logged and changes nothing.
     */
    private publishSendEvent(
        action: SendEventAction,
        message: M,
        folderUids: (string | undefined)[],
        outcome: { attempt: number; nextAttemptAt?: Date; error?: { message: string; details?: MailRelayFailureDetails } },
    ): void {
        try {
            const data: SendEventData = {
                uid: message.uid,
                mailboxUid: message.mailboxUid,
                subject: message.subject ?? "",
                recipients: (Array.isArray(message.recipients) ? message.recipients : []).map((recipient) => recipient.address),
                attempt: outcome.attempt,
                ...(outcome.nextAttemptAt ? { nextAttemptAt: outcome.nextAttemptAt.toISOString() } : {}),
                ...(outcome.error ? { error: { message: outcome.error.message, ...(outcome.error.details ? { details: outcome.error.details } : {}) } } : {}),
            };
            const channels: string[] = [...new Set([message.mailboxUid, ...folderUids].filter((uid): uid is string => !!uid))];
            this.notificationUtils?.sendMessage(channels, this.messageClass.name, action, data);
            /* v8 ignore start -- only a notification transport that throws synchronously */
        } catch (err: any) {
            this.logger?.warn(`ScheduledSendJob: failed to publish ${action} for message ${message.uid}: ${err?.message}`);
        }
        /* v8 ignore stop */
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

    /** Where delivery failure notices are filed. */
    private noticeSink(): DeliveryNoticeSink {
        return {
            messageRepo: this.messageRepo!,
            messageClass: this.messageClass,
            folderRepo: this.folderRepo!,
            folderClass: this.folderClass,
            blobStore: this.blobStore!,
            notificationUtils: this.notificationUtils,
            logger: this.logger,
        };
    }

    /**
     * Tells `message`'s sender in their Inbox that it was not delivered (to everyone) - see `util/DeliveryFailureNoticeUtils.ts`:
     * `details` is what the transport said (per-recipient status and responses, its error), `reason` the explanation in words
     * when the mail system has none of its own (this job refusing the message). Best-effort and idempotent per `key`.
     */
    private async reportUndelivered(
        message: M,
        key: string,
        details: MailRelayFailureDetails | undefined,
        extra: { reason?: string; attempts?: number; messageId?: string; error?: TransportError },
    ): Promise<void> {
        await tryFileDeliveryFailureNotice(this.noticeSink(), `scheduled message ${message.uid}`, async () => {
            const mailbox: Mailbox | undefined = await this.mailboxRepo!.findOne(message.mailboxUid, { ignoreACL: true });
            if (!mailbox) {
                return undefined;
            }
            const recipients: string[] = (Array.isArray(message.recipients) ? message.recipients : []).map((recipient) => recipient.address);
            const failures: TransportFailure[] =
                details && details.failures.length > 0
                    ? details.failures
                    : recipients.map((address) => ({ address, response: extra.reason, temporary: false }));
            return {
                mailboxUid: message.mailboxUid,
                mailboxAddress: mailbox.primarySmtpAddress,
                key,
                original: await describeOriginal(this.blobStore!, message, { messageId: extra.messageId }),
                failures,
                error: details?.error ?? extra.error,
                transport: details?.transport,
                reason: extra.reason,
                attempts: extra.attempts,
            };
        });
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
        this.publishSendEvent("send-failed", message, [message.folderUid], {
            attempt: ((message as any).scheduledSendAttempts ?? 0) + 1,
            error: { message: reason },
        });
        await this.reportUndelivered(message, deliveryFailureKey("scheduled-refused", message.uid, String((message as any).version)), undefined, {
            reason,
        });
    }

    /** Returns a refusal reason if `message` must not be relayed (or, with `folderOnly` - an already-relayed message
     * that only needs filing - must not be filed); otherwise the sending mailbox's own (normalized) addresses, for the
     * stored MIME's originator-header check. */
    private async validateForRelay(
        message: M,
        folderOnly: boolean = false,
    ): Promise<{ refusal?: string; ownAddresses?: Set<string>; mailbox?: Mailbox }> {
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
        return { ownAddresses, mailbox };
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
            // A failure no retry can fix (a spam/malware verdict, every recipient refused with an SMTP 5xx) is final at once.
            const permanent: boolean = isPermanentRelayFailure(err);
            const exhausted: boolean = permanent || attempts >= this.maxAttempts;
            const finalReason: string = permanent && attempts < this.maxAttempts ? reason : `Gave up after ${attempts} attempts: ${reason}`;
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
                    scheduledSendError: exhausted ? finalReason : reason,
                } as any,
                asEntity(this.messageRepo!, current),
                { ignoreACL: true },
            );
            if (exhausted) {
                this.logger?.error(`ScheduledSendJob: giving up on scheduled message ${uid} after ${attempts} attempt(s): ${reason}`);
                this.publishSendEvent("send-failed", current, [current.folderUid], {
                    attempt: attempts,
                    error: { message: this.eventErrorMessage(finalReason, extra), details: err?.details },
                });
                // A message the transport had accepted (`scheduledSendRelayedAt`) is not undelivered - it only failed to be filed.
                if (!extra.scheduledSendRelayedAt) {
                    const details: MailRelayFailureDetails | undefined = err?.details;
                    await this.reportUndelivered(current, deliveryFailureKey("scheduled-failed", uid, String((current as any).version)), details, {
                        reason: finalReason,
                        attempts,
                        error: details ? undefined : { message: reason },
                    });
                }
            } else {
                this.publishSendEvent("send-retrying", current, [current.folderUid], {
                    attempt: attempts,
                    nextAttemptAt,
                    error: { message: this.eventErrorMessage(reason, extra), details: err?.details },
                });
            }
        } catch (updateErr: any) {
            this.logger?.warn(`ScheduledSendJob: failed to record a failed attempt for ${uid}: ${updateErr.message}`);
        }
    }
}
