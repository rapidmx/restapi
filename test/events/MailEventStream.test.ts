///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    boundMailEvent,
    MAIL_EVENT_STREAM_KEY,
    MailEvent,
    MailEventConsumer,
    MailEventStream,
    MailEventType,
    publishTransportOutcome,
} from "../../src/events/MailEventStream.js";
import { FakeRedisStream } from "./FakeRedisStream.js";

function makeStream(redis: any, overrides: Record<string, unknown> = {}): { stream: MailEventStream; logger: { warn: any; error: any } } {
    const stream = new MailEventStream();
    const logger = { warn: vi.fn(), error: vi.fn() };
    Object.assign(stream as any, { connectionManager: { connections: new Map([["events", redis]]) }, logger, ...overrides });
    return { stream, logger };
}

class RecordingConsumer extends MailEventConsumer {
    protected readonly consumerGroup: string = "test-plugin";
    public handled: { event: MailEvent; id: string }[] = [];
    public failFor: Set<string> = new Set();

    protected async handle(event: MailEvent, id: string): Promise<void> {
        if (this.failFor.has((event as any).messageId)) {
            throw new Error("handler failed");
        }
        this.handled.push({ event, id });
    }
}

function makeConsumer(stream: MailEventStream, overrides: Record<string, unknown> = {}): { consumer: RecordingConsumer; logger: { warn: any; error: any } } {
    const consumer = new RecordingConsumer();
    const logger = { warn: vi.fn(), error: vi.fn() };
    Object.assign(consumer as any, { mailEventStream: stream, logger, ...overrides });
    return { consumer, logger };
}

const sent = (messageId: string) => ({ type: "message.sent" as const, messageId, envelopeFrom: "a@a.example", recipients: ["b@b.example"], source: "compose" });

describe("boundMailEvent()", () => {
    const delivered = (overrides: Record<string, unknown> = {}): MailEvent =>
        ({ type: "message.delivered", occurredAt: "t", mailboxUid: "mb", messageUid: "u", junk: false, envelopeFrom: "a@a.example", envelopeTo: ["b@b.example"], references: [], ...overrides });

    it("Clips a delivered message's text fields, references and recipients, and publishes the clipped event.", async () => {
        const long = "x".repeat(100_000);
        const event = boundMailEvent(
            delivered({
                subject: long,
                messageId: long,
                inReplyTo: long,
                fromAddress: long,
                autoSubmitted: long,
                precedence: long,
                envelopeFrom: long,
                envelopeTo: Array.from({ length: 500 }, (_, i) => `${i}${long}`),
                references: Array.from({ length: 300 }, (_, i) => `${i}${long}`),
            }),
        ) as any;
        expect(event.subject).toHaveLength(1000);
        expect(event.messageId).toHaveLength(1000);
        expect(event.envelopeFrom).toHaveLength(320);
        expect(event.fromAddress).toHaveLength(320);
        expect(event.envelopeTo).toHaveLength(100);
        expect(event.envelopeTo[0]).toHaveLength(320);
        // The nearest ancestors are kept: the last 20, in order.
        expect(event.references).toHaveLength(20);
        expect(event.references[19].startsWith("299")).toBe(true);
        expect(event.references[0].startsWith("280")).toBe(true);
        expect(JSON.stringify(event).length).toBeLessThan(64 * 1024);

        const redis = new FakeRedisStream();
        await makeStream(redis).stream.publish({ ...(delivered({ subject: long }) as any), occurredAt: undefined });
        expect(JSON.parse(redis.entries[0].message.event).subject).toHaveLength(1000);
    });

    it("Leaves a small event untouched, and drops a parsed report only when the event is still over 64 KB.", () => {
        const small = delivered({ subject: "Hi", references: ["<a@b>"], deliveryStatusReport: { recipients: [] } });
        expect(boundMailEvent(small)).toEqual(small);
        expect(boundMailEvent(delivered({ references: undefined }))).toMatchObject({ references: [] });
        const huge = delivered({ deliveryStatusReport: { recipients: Array.from({ length: 200 }, () => ({ note: "y".repeat(1000) })) }, feedbackReport: { x: "z".repeat(70_000) } }) as any;
        const bounded = boundMailEvent(huge) as any;
        expect(bounded.deliveryStatusReport).toBeUndefined();
        expect(bounded.feedbackReport).toBeUndefined();
        expect(bounded.messageUid).toBe("u");
    });

    it("Clips a sent event's recipients and a failed one's failures.", () => {
        const long = "q".repeat(5000);
        const sentEvent = boundMailEvent({ type: "message.sent", occurredAt: "t", messageId: long, envelopeFrom: long, recipients: Array.from({ length: 300 }, () => long), source: "compose" }) as any;
        expect(sentEvent.recipients).toHaveLength(100);
        expect(sentEvent.recipients[0]).toHaveLength(320);
        expect(sentEvent.messageId).toHaveLength(1000);
        const failed = boundMailEvent({
            type: "send.failed",
            occurredAt: "t",
            messageId: long,
            envelopeFrom: long,
            failures: Array.from({ length: 300 }, () => ({ recipient: long, temporary: true, message: long })),
            source: "compose",
        }) as any;
        expect(failed.failures).toHaveLength(100);
        expect(failed.failures[0].recipient).toHaveLength(320);
        expect(failed.failures[0].message).toHaveLength(1000);
        expect(failed.messageId).toHaveLength(1000);
    });
});

describe("MailEventStream", () => {
    it("Appends a timestamped, JSON-encoded event to the stream, trimmed to the configured length", async () => {
        const redis = new FakeRedisStream();
        const { stream } = makeStream(redis, { maxLength: 2 });

        await stream.publish(sent("m1"));
        await stream.publish({ ...sent("m2"), occurredAt: "2026-09-29T00:00:00.000Z" });
        await stream.publish(sent("m3"));

        expect(redis.entries).toHaveLength(2);
        const events = redis.entries.map((entry) => JSON.parse(entry.message.event));
        expect(events.map((event) => event.messageId)).toEqual(["m2", "m3"]);
        expect(events[0].occurredAt).toBe("2026-09-29T00:00:00.000Z");
        expect(Date.parse(events[1].occurredAt)).not.toBeNaN();
        expect(MAIL_EVENT_STREAM_KEY).toBe("rapidmx:mail-events");
    });

    it("Does nothing without an events datastore, with a client that has no stream commands, or when switched off", async () => {
        const redis = new FakeRedisStream();

        await makeStream(undefined).stream.publish(sent("m1"));
        await makeStream({ publish: vi.fn() }).stream.publish(sent("m1"));
        await makeStream(redis, { enabled: false }).stream.publish(sent("m1"));
        const unwired = new MailEventStream();
        await unwired.publish(sent("m1"));

        expect(redis.entries).toEqual([]);
        expect(unwired.redis()).toBeUndefined();
    });

    it("Logs and drops a Redis failure instead of throwing into mail flow", async () => {
        const redis = new FakeRedisStream();
        const { stream, logger } = makeStream(redis);
        redis.failNext.set("xAdd", new Error("connection lost"));

        await expect(stream.publish(sent("m1"))).resolves.toBeUndefined();

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("connection lost"));
        redis.failNext.set("xAdd", "plain failure" as any);
        await stream.publish(sent("m2"));
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("plain failure"));
    });

    it("Gives up on an xAdd that never settles (Redis down, command queued offline) so mail flow is not blocked", async () => {
        const redis = { xAdd: vi.fn(() => new Promise<string>(() => undefined)) };
        const { stream, logger } = makeStream(redis, { publishTimeoutMs: 20 });

        await expect(stream.publish(sent("m1"))).resolves.toBeUndefined();

        expect(redis.xAdd).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("may still be delivered"));
    });

    it.each([["2000"], ["abc"], [0], [-5], [NaN], [undefined]])("Falls back to the default wait for a bad publish timeout (%j) instead of dropping every event", async (bad) => {
        // Settles after 30 ms: a timeout that fires at once (setTimeout's reading of NaN) would beat it.
        const redis = { xAdd: vi.fn(() => new Promise<string>((resolve) => setTimeout(() => resolve("1-0"), 30))) };
        const { stream, logger } = makeStream(redis, { publishTimeoutMs: bad });

        await stream.publish(sent("m1"));

        expect(redis.xAdd).toHaveBeenCalledTimes(1);
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it("Does not log a timeout for an xAdd that settles in time", async () => {
        const redis = new FakeRedisStream();
        const { stream, logger } = makeStream(redis, { publishTimeoutMs: 1000 });

        await stream.publish(sent("m1"));

        expect(redis.entries).toHaveLength(1);
        expect(logger.warn).not.toHaveBeenCalled();
    });
});

describe("publishTransportOutcome()", () => {
    const message = { messageId: "m1", envelopeFrom: "a@a.example", envelopeTo: ["b@x.example", "c@x.example"] };

    async function outcome(result: any, context: any = { source: "plugin", mailboxUid: "mb", messageUid: "msg" }) {
        const redis = new FakeRedisStream();
        const { stream } = makeStream(redis);
        await publishTransportOutcome(context && { stream, ...context }, message, result);
        return redis.entries.map((entry) => JSON.parse(entry.message.event));
    }

    it("Publishes message.sent for the accepted recipients only when nothing was refused", async () => {
        const events = await outcome({ accepted: ["b@x.example", "c@x.example"], rejected: [] });

        expect(events).toEqual([
            expect.objectContaining({
                type: "message.sent",
                mailboxUid: "mb",
                messageUid: "msg",
                messageId: "m1",
                envelopeFrom: "a@a.example",
                recipients: ["b@x.example", "c@x.example"],
                source: "plugin",
            }),
        ]);
    });

    it("Publishes both events for a partial refusal, with each refused recipient's own failure", async () => {
        const events = await outcome({
            accepted: ["b@x.example"],
            rejected: ["c@x.example"],
            failures: [{ address: "c@x.example", code: 450, enhancedCode: "4.2.1", response: "450 try later", temporary: true }],
        });

        expect(events.map((event) => event.type)).toEqual(["message.sent", "send.failed"]);
        expect(events[1].failures).toEqual([{ recipient: "c@x.example", code: 450, enhancedCode: "4.2.1", temporary: true, message: "450 try later" }]);
    });

    it("Publishes send.failed for every envelope recipient when the whole call failed, taking the call's own error", async () => {
        const events = await outcome({ accepted: [], rejected: [], error: { message: "sendmail exited 75", temporary: true } });

        expect(events).toEqual([
            expect.objectContaining({
                type: "send.failed",
                failures: [
                    { recipient: "b@x.example", temporary: true, message: "sendmail exited 75" },
                    { recipient: "c@x.example", temporary: true, message: "sendmail exited 75" },
                ],
            }),
        ]);
    });

    it("Counts a refusal as permanent when nothing says it is temporary, and uses the rejected list when there is one", async () => {
        const events = await outcome({ accepted: [], rejected: ["c@x.example"] });

        expect(events[0].failures).toEqual([{ recipient: "c@x.example", temporary: false }]);
    });

    it("Publishes nothing without a context or a stream in it", async () => {
        expect(await outcome({ accepted: ["b@x.example"] }, null)).toEqual([]);
        await expect(publishTransportOutcome({ source: "compose" }, message, { accepted: ["b@x.example"] })).resolves.toBeUndefined();
    });
});

describe("MailEventConsumer", () => {
    it("Creates its group at the stream's end - earlier events are not replayed - then handles and acknowledges new ones", async () => {
        const redis = new FakeRedisStream();
        const { stream } = makeStream(redis);
        const { consumer } = makeConsumer(stream);
        await stream.publish(sent("before"));

        await consumer.run();
        await stream.publish(sent("after-1"));
        await stream.publish(sent("after-2"));
        await consumer.run();

        expect(consumer.handled.map(({ event }) => (event as any).messageId)).toEqual(["after-1", "after-2"]);
        expect(consumer.handled[0].id).toBe(redis.entries[1].id);
        expect(redis.groups.get("test-plugin")!.pending.size).toBe(0);
    });

    it("Joins an existing group, reads in batches up to its per-run cap, and exposes its schedule", async () => {
        const redis = new FakeRedisStream();
        const { stream } = makeStream(redis);
        await redis.xGroupCreate(MAIL_EVENT_STREAM_KEY, "test-plugin", "0");
        for (let i = 0; i < 5; i++) {
            await stream.publish(sent(`m${i}`));
        }
        const { consumer } = makeConsumer(stream, { batchSize: 2, maxBatchesPerRun: 2 });

        consumer.start();
        await consumer.run();
        expect(consumer.handled).toHaveLength(4);
        await consumer.run();
        consumer.stop();

        expect(consumer.handled).toHaveLength(5);
        expect(consumer.schedule).toBe("*/2 * * * * *");
    });

    it("Acknowledges events of types it doesn't want, and malformed entries, without handing them over", async () => {
        const redis = new FakeRedisStream();
        const { stream } = makeStream(redis);
        const { consumer, logger } = makeConsumer(stream);
        (consumer as any).eventTypes = ["message.delivered"] satisfies MailEventType[];
        await consumer.run();
        await stream.publish(sent("m1"));
        await redis.xAdd(MAIL_EVENT_STREAM_KEY, "*", { event: "{not json" });
        await redis.xAdd(MAIL_EVENT_STREAM_KEY, "*", { event: JSON.stringify({ no: "type" }) });
        await redis.xAdd(MAIL_EVENT_STREAM_KEY, "*", {});
        await stream.publish({ type: "message.delivered", mailboxUid: "mb", messageUid: "u", junk: false, envelopeFrom: "", envelopeTo: [], references: [] });

        await consumer.run();

        expect(consumer.handled.map(({ event }) => event.type)).toEqual(["message.delivered"]);
        expect(logger.warn).toHaveBeenCalledTimes(3);
        expect(redis.groups.get("test-plugin")!.pending.size).toBe(0);
    });

    it("Leaves a failed event pending, retries it once idle long enough, and gives up after too many attempts", async () => {
        const redis = new FakeRedisStream();
        const { stream } = makeStream(redis);
        const { consumer, logger } = makeConsumer(stream, { retryAfterMs: 1000, maxDeliveries: 3 });
        await consumer.run();
        await stream.publish(sent("flaky"));
        await stream.publish(sent("poison"));
        consumer.failFor = new Set(["flaky", "poison"]);

        await consumer.run();
        expect(redis.groups.get("test-plugin")!.pending.size).toBe(2);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("handler failed"));

        // Not idle long enough yet: nothing is retried.
        redis.now += 500;
        await consumer.run();
        expect(consumer.handled).toEqual([]);

        // The flaky one recovers on its retry; the poison one keeps failing.
        consumer.failFor = new Set(["poison"]);
        redis.now += 1000;
        await consumer.run();
        expect(consumer.handled.map(({ event }) => (event as any).messageId)).toEqual(["flaky"]);
        expect(redis.groups.get("test-plugin")!.pending.size).toBe(1);

        redis.now += 1000;
        await consumer.run();
        // Delivered 3 times now: the next run gives up on it.
        redis.now += 1000;
        await consumer.run();
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("giving up"));
        expect(redis.groups.get("test-plugin")!.pending.size).toBe(0);
    });

    it("Skips a reclaimed entry that was trimmed from the stream in the meantime", async () => {
        const redis = new FakeRedisStream();
        const { stream } = makeStream(redis);
        const { consumer } = makeConsumer(stream, { retryAfterMs: 1000 });
        await consumer.run();
        await stream.publish(sent("gone"));
        consumer.failFor = new Set(["gone"]);
        await consumer.run();
        redis.entries = [];

        redis.now += 1000;
        await consumer.run();

        expect(consumer.handled).toEqual([]);
    });

    it("Does nothing without Redis, and logs a read failure instead of throwing", async () => {
        const { consumer: unwired } = makeConsumer(makeStream(undefined).stream);
        await expect(unwired.run()).resolves.toBeUndefined();
        const orphan = new RecordingConsumer();
        await expect(orphan.run()).resolves.toBeUndefined();

        const redis = new FakeRedisStream();
        const { stream } = makeStream(redis);
        const { consumer, logger } = makeConsumer(stream);
        redis.failNext.set("xGroupCreate", new Error("NOAUTH"));
        await consumer.run();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("NOAUTH"));

        // The group is created on the retry; a later read failure is logged the same way.
        await consumer.run();
        redis.failNext.set("xReadGroup", "read failed" as any);
        await consumer.run();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("read failed"));
    });
});
