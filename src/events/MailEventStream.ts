///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import os from "node:os";
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, ConnectionManager } from "@rapidrest/service-core";
import type { DeliveryStatusReport, FeedbackReport } from "../util/DsnParser.js";
const { Config, Inject, Logger } = ObjectDecorators;

/** The Redis stream (on the `events` datastore) every mail event is appended to. */
export const MAIL_EVENT_STREAM_KEY = "rapidmx:mail-events";

/** The field of a stream entry that holds the JSON-encoded `MailEvent`. */
const EVENT_FIELD = "event";

/** Every kind of `MailEvent`. */
export type MailEventType = MailEvent["type"];

/** What every mail event carries. */
export interface MailEventBase {
    /** When the event happened, as an ISO 8601 timestamp. */
    occurredAt: string;
}

/**
 * A message was filed into a mailbox - into its Inbox (or wherever its mail filter rules put it) or its Junk folder. Published once
 * per delivered copy, after the message row exists; never for mail that was quarantined, dropped for an erasure, or consumed as a
 * control message (a recall, a read receipt, an ACME challenge).
 *
 * A bounce (a delivery status notification) or an abuse/feedback report that was filed carries its parsed report too, which is
 * how a plugin that sent the original learns of a failed delivery or a spam complaint.
 */
export interface MessageDeliveredEvent extends MailEventBase {
    type: "message.delivered";
    /** The mailbox the copy was filed into. */
    mailboxUid: string;
    /** The uid of the filed `Message` row. A mail filter rule may have deleted it since. */
    messageUid: string;
    /** Whether the copy was filed as junk. */
    junk: boolean;
    /** The SMTP envelope sender (`MAIL FROM`) - empty for a bounce, which has a null sender. */
    envelopeFrom: string;
    /** The SMTP envelope recipient(s) this copy was delivered for, exactly as given - including any `+tag`, which a VERP return
     * path (`bounces+<token>@domain`) depends on. */
    envelopeTo: string[];
    /** The bare address of the `From` header, if any. */
    fromAddress?: string;
    subject?: string;
    /** The `Message-ID` header, angle brackets stripped. */
    messageId?: string;
    /** The `In-Reply-To` header, angle brackets stripped. */
    inReplyTo?: string;
    /** The `References` header, oldest first, angle brackets stripped. */
    references: string[];
    /** The `Auto-Submitted` header, if any - anything other than `no` marks an automatic message (an out-of-office reply, say). */
    autoSubmitted?: string;
    /** The `Precedence` header, if any (`bulk`, `list`, `junk`, `auto_reply`). */
    precedence?: string;
    /** The parsed delivery status report, when the message is a bounce - see `util/DsnParser.ts`. Attacker-controlled input: anyone can
     * send a message shaped like a bounce. See `reportAuthenticated`. */
    deliveryStatusReport?: DeliveryStatusReport;
    /** The parsed abuse/feedback report, when the message is one - see `util/DsnParser.ts`. Attacker-controlled input, like
     * `deliveryStatusReport`. */
    feedbackReport?: FeedbackReport;
    /**
     * Set only on a message that carries a `deliveryStatusReport` or `feedbackReport`: `true` when its `From` address is authenticated
     * (a passing DKIM result aligned with the `From` domain, stamped by this deployment's trusted MTA hop), `false` when it is not.
     * Absent on any other message. A consumer must not act on a report that is not `true` - and even a `true` only proves who sent it,
     * not that the report is about something this deployment sent - so it must still correlate the report to a message it sent
     * itself (`originalMessageId`, the VERP address in `envelopeTo`) before suppressing an address or the like.
     */
    reportAuthenticated?: boolean;
}

/** Where an outbound message came from. */
export type MailSendSource = "compose" | "scheduled" | "auto_reply" | "plugin" | string;

/**
 * A message was handed to the mail transport and at least one recipient was accepted. Acceptance by the transport is not
 * delivery: a later bounce arrives as a `message.delivered` event carrying a `deliveryStatusReport`.
 */
export interface MessageSentEvent extends MailEventBase {
    type: "message.sent";
    /** The sending mailbox, when the message was sent from one. */
    mailboxUid?: string;
    /** The sent `Message` row, when one was kept (the Sent Items copy). */
    messageUid?: string;
    /** The `Message-ID` header, angle brackets stripped. */
    messageId: string;
    envelopeFrom: string;
    /** The recipients the transport accepted. */
    recipients: string[];
    source: MailSendSource;
}

/** One recipient the transport refused. */
export interface MailSendFailure {
    recipient: string;
    /** The SMTP reply code, when the transport reported one. */
    code?: number;
    /** The RFC 3463 enhanced status code, when the transport reported one. */
    enhancedCode?: string;
    /** Whether the refusal is temporary (a retry may succeed). */
    temporary: boolean;
    message?: string;
}

/** The transport refused some or all recipients of an outbound message synchronously. */
export interface SendFailedEvent extends MailEventBase {
    type: "send.failed";
    mailboxUid?: string;
    messageUid?: string;
    messageId?: string;
    envelopeFrom: string;
    /** Why each refused recipient was refused. A failure marked `temporary` may still succeed if the sender retries - a scheduled
     * send does, up to its attempt limit. */
    failures: MailSendFailure[];
    source: MailSendSource;
}

/** Every event on the mail event stream. */
export type MailEvent = MessageDeliveredEvent | MessageSentEvent | SendFailedEvent;

/** What a sender knows about an outbound message that `publishTransportOutcome()` puts on its events. */
export interface MailSendContext {
    /** The stream to publish to; nothing is published without one. */
    stream?: MailEventStream;
    mailboxUid?: string;
    messageUid?: string;
    source: MailSendSource;
}

/** The part of a `TransportResult` (`transport/MailTransport.ts`) `publishTransportOutcome()` reads. */
interface TransportOutcome {
    accepted: string[];
    rejected?: string[];
    failures?: { address: string; code?: number; enhancedCode?: string; response?: string; temporary?: boolean }[];
    error?: { message?: string; temporary?: boolean };
}

/**
 * Publishes what the transport did with one outbound message: `message.sent` for the recipients it accepted (if any), and
 * `send.failed` for those it refused (if any) - a refused recipient with no failure entry of its own takes the whole call's error,
 * and counts as temporary only when that error says so. Never throws.
 */
export async function publishTransportOutcome(
    context: MailSendContext | undefined,
    message: { messageId: string; envelopeFrom: string; envelopeTo: string[] },
    result: TransportOutcome,
): Promise<void> {
    if (!context?.stream) {
        return;
    }
    const base = { mailboxUid: context.mailboxUid, messageUid: context.messageUid, envelopeFrom: message.envelopeFrom, source: context.source };
    if (result.accepted.length > 0) {
        await context.stream.publish({ type: "message.sent", ...base, messageId: message.messageId, recipients: [...result.accepted] });
    }
    const refused: string[] =
        result.accepted.length === 0 ? (result.rejected?.length ? result.rejected : message.envelopeTo) : (result.rejected ?? []);
    if (refused.length > 0) {
        const failures: MailSendFailure[] = refused.map((recipient) => {
            const failure = result.failures?.find((entry) => entry.address === recipient);
            return {
                recipient,
                code: failure?.code,
                enhancedCode: failure?.enhancedCode,
                temporary: failure?.temporary ?? result.error?.temporary ?? false,
                message: failure?.response ?? result.error?.message,
            };
        });
        await context.stream.publish({ type: "send.failed", ...base, messageId: message.messageId, failures });
    }
}

/** A `MailEvent` without its timestamp, which `publish()` fills in when the caller leaves it out. */
export type MailEventInput = MailEvent extends infer E ? (E extends MailEvent ? Omit<E, "occurredAt"> & { occurredAt?: string } : never) : never;

/** The part of a node-redis client the stream uses. */
export interface MailEventRedis {
    xAdd(key: string, id: string, message: Record<string, string>, options?: any): Promise<string>;
    xGroupCreate(key: string, group: string, id: string, options?: any): Promise<unknown>;
    xReadGroup(group: string, consumer: string, streams: { key: string; id: string }, options?: any): Promise<any>;
    xAck(key: string, group: string, id: string | string[]): Promise<number>;
    xAutoClaim(key: string, group: string, consumer: string, minIdleTime: number, start: string, options?: any): Promise<any>;
    xPendingRange(key: string, group: string, start: string, end: string, count: number, options?: any): Promise<any[]>;
}

/**
 * Publishes `MailEvent`s to a Redis stream (`MAIL_EVENT_STREAM_KEY` on the `events` datastore) that plugins read with a
 * `MailEventConsumer`. A stream rather than pub/sub: an event published while a consumer is restarting waits for it instead of
 * being lost, and each consumer group sees every event exactly once per group (at least once per event - a consumer that fails
 * after handling an event but before acknowledging it sees it again, so handlers must be idempotent).
 *
 * Publishing never throws and never blocks mail flow on Redis: without an `events` datastore (a single-process development
 * setup), or with `mail:events:enabled` off, it does nothing; a Redis error - or a Redis that does not answer within `mail:events:publish_timeout_ms` (2 seconds by default) - is logged and dropped. The stream is capped at roughly
 * `mail:events:max_length` entries (oldest trimmed first), so a consumer that stays down long enough loses the oldest events.
 */
export class MailEventStream {
    @Inject(ConnectionManager)
    private connectionManager?: ConnectionManager;

    @Config("mail:events:enabled", true)
    private enabled: boolean = true;

    @Config("mail:events:datastore", "events")
    private datastoreName: string = "events";

    @Config("mail:events:max_length", 100000)
    private maxLength: number = 100000;

    /** How long `publish()` waits for Redis before it stops waiting for an event (with a warning) - the append may still reach the
     * stream afterwards. A value that is not a finite positive number (an environment string, say) falls back to the 2000 ms default. */
    @Config("mail:events:publish_timeout_ms", 2000)
    private publishTimeoutMs: number = 2000;

    @Logger
    private logger?: any;

    /** The Redis client of the configured datastore, or `undefined` when there is none (or streams are switched off). */
    public redis(): MailEventRedis | undefined {
        if (!this.enabled) {
            return undefined;
        }
        const client: any = this.connectionManager?.connections.get(this.datastoreName);
        return client && typeof client.xAdd === "function" ? (client as MailEventRedis) : undefined;
    }

    /** Appends `event` to the stream - see the class comment for what happens when that can't be done. */
    public async publish(event: MailEventInput): Promise<void> {
        const redis: MailEventRedis | undefined = this.redis();
        if (!redis) {
            return;
        }
        const full: MailEvent = { ...event, occurredAt: event.occurredAt ?? new Date().toISOString() };
        // node-redis queues a command while its connection is down and keeps it pending until the connection returns, so the
        // append is bounded: a stream that can't be reached must cost mail flow at most `publishTimeoutMs`, not stall it.
        const configured: number = Number(this.publishTimeoutMs);
        const waitMs: number = Number.isFinite(configured) && configured > 0 ? configured : 2000;
        let timer: NodeJS.Timeout | undefined;
        const timeout: Promise<never> = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`gave up waiting after ${waitMs} ms; it may still be delivered`)), waitMs);
        });
        try {
            await Promise.race([
                redis.xAdd(
                    MAIL_EVENT_STREAM_KEY,
                    "*",
                    { [EVENT_FIELD]: JSON.stringify(full) },
                    { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: this.maxLength } },
                ),
                timeout,
            ]);
        } catch (err: any) {
            this.logger?.warn(`MailEventStream: failed to publish a ${full.type} event: ${err?.message ?? err}`);
        } finally {
            clearTimeout(timer);
        }
    }
}

/**
 * Reads the mail event stream as one consumer group and hands each event to `handle()`. Every replica of a plugin joins the same
 * group (`consumerGroup`), so each event is handled by one replica only; each replica reads as its own consumer.
 *
 * Runs on a schedule (`schedule`, every 2 seconds by default) like any `BackgroundService` - each run reads until the stream has
 * nothing new for this group (at most `maxBatchesPerRun` batches of `batchSize`), without blocking the shared connection. An
 * event whose handler throws is left unacknowledged and retried once it has been idle for `retryAfterMs`, by whichever replica
 * runs next; after `maxDeliveries` attempts it is acknowledged and logged, so one bad event can't stall the group.
 *
 * The group is created at the stream's current end the first time a consumer runs: events published before a plugin was ever
 * installed are not replayed to it.
 *
 * Subclasses (exported, concrete, from a plugin's `./mongo`/`./sql` entry points) supply `consumerGroup` and `handle()`, and may
 * narrow `eventTypes`.
 */
export abstract class MailEventConsumer extends BackgroundService {
    /** The consumer group this consumer reads as - one per plugin (or per independent purpose within a plugin). */
    protected abstract readonly consumerGroup: string;

    /** The event types `handle()` wants; every other event is acknowledged without being handed over. `undefined` means all. */
    protected readonly eventTypes?: ReadonlyArray<MailEventType>;

    /** Handles one event. Throwing leaves it unacknowledged for a retry - see the class comment. Must be idempotent. */
    protected abstract handle(event: MailEvent, id: string): Promise<void>;

    @Inject(MailEventStream)
    protected mailEventStream?: MailEventStream;

    @Logger
    protected logger?: any;

    protected scheduleExpr: string = "*/2 * * * * *";
    protected batchSize: number = 100;
    protected maxBatchesPerRun: number = 20;
    protected retryAfterMs: number = 60000;
    protected maxDeliveries: number = 5;

    /** This process's consumer name within the group. */
    protected readonly consumerName: string = `${os.hostname()}-${process.pid}`;

    private groupReady: boolean = false;

    public get schedule(): string | undefined {
        return this.scheduleExpr;
    }

    public start(): void {
        // Nothing to prepare - the group is created lazily on the first run, once Redis is known to be there.
    }

    public stop(): void {
        // Nothing to release - every run finishes its batch before returning.
    }

    public async run(): Promise<void> {
        const redis: MailEventRedis | undefined = this.mailEventStream?.redis();
        if (!redis) {
            return;
        }
        try {
            await this.ensureGroup(redis);
            await this.retryStalled(redis);
            for (let batch = 0; batch < this.maxBatchesPerRun; batch++) {
                const reply: any = await redis.xReadGroup(
                    this.consumerGroup,
                    this.consumerName,
                    { key: MAIL_EVENT_STREAM_KEY, id: ">" },
                    { COUNT: this.batchSize },
                );
                const messages: any[] = reply?.[0]?.messages ?? [];
                if (messages.length === 0) {
                    break;
                }
                for (const message of messages) {
                    await this.dispatch(redis, message);
                }
            }
        } catch (err: any) {
            this.logger?.warn(`${this.constructor.name}: failed to read the mail event stream: ${err?.message ?? err}`);
        }
    }

    /** Creates the group at the stream's end (and the stream itself, if nothing was ever published); an existing group is fine. */
    private async ensureGroup(redis: MailEventRedis): Promise<void> {
        if (this.groupReady) {
            return;
        }
        try {
            await redis.xGroupCreate(MAIL_EVENT_STREAM_KEY, this.consumerGroup, "$", { MKSTREAM: true });
        } catch (err: any) {
            if (!String(err?.message ?? err).includes("BUSYGROUP")) {
                throw err;
            }
        }
        this.groupReady = true;
    }

    /**
     * Gives up on events that failed `maxDeliveries` times, then claims (for this consumer) and re-handles every other event some
     * consumer of the group read but hasn't acknowledged for `retryAfterMs` - a handler failure, or a replica that died mid-batch.
     */
    private async retryStalled(redis: MailEventRedis): Promise<void> {
        const pending: any[] = await redis.xPendingRange(MAIL_EVENT_STREAM_KEY, this.consumerGroup, "-", "+", this.batchSize, {
            IDLE: this.retryAfterMs,
        });
        for (const entry of pending ?? []) {
            if (Number(entry.deliveriesCounter) >= this.maxDeliveries) {
                this.logger?.error(
                    `${this.constructor.name}: giving up on mail event ${entry.id} after ${entry.deliveriesCounter} failed attempts.`,
                );
                await redis.xAck(MAIL_EVENT_STREAM_KEY, this.consumerGroup, entry.id);
            }
        }
        const claimed: any = await redis.xAutoClaim(MAIL_EVENT_STREAM_KEY, this.consumerGroup, this.consumerName, this.retryAfterMs, "0-0", {
            COUNT: this.batchSize,
        });
        for (const message of claimed?.messages ?? []) {
            if (message) {
                await this.dispatch(redis, message);
            }
        }
    }

    /** Hands one stream entry to `handle()` and acknowledges it - unless the handler throws. Malformed entries are acknowledged. */
    private async dispatch(redis: MailEventRedis, message: { id: string; message: Record<string, string> }): Promise<void> {
        let event: MailEvent | undefined;
        try {
            event = JSON.parse(message.message?.[EVENT_FIELD] ?? "");
        } catch {
            event = undefined;
        }
        if (!event || typeof event.type !== "string") {
            this.logger?.warn(`${this.constructor.name}: skipping malformed mail event ${message.id}.`);
            await redis.xAck(MAIL_EVENT_STREAM_KEY, this.consumerGroup, message.id);
            return;
        }
        if (this.eventTypes && !this.eventTypes.includes(event.type)) {
            await redis.xAck(MAIL_EVENT_STREAM_KEY, this.consumerGroup, message.id);
            return;
        }
        try {
            await this.handle(event, message.id);
        } catch (err: any) {
            this.logger?.warn(`${this.constructor.name}: handling mail event ${message.id} (${event.type}) failed: ${err?.message ?? err}`);
            return;
        }
        await redis.xAck(MAIL_EVENT_STREAM_KEY, this.consumerGroup, message.id);
    }
}
