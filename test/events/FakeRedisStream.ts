///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// An in-memory stand-in for the Redis stream commands `events/MailEventStream.ts` uses, with the semantics that matter to it:
// entries get increasing ids, a group created at `$` only sees what is added afterwards, `>` hands each entry to one consumer and
// puts it in the group's pending list, `XACK` removes it, `XPENDING ... IDLE` and `XAUTOCLAIM` find entries idle long enough and
// the latter re-delivers them (bumping their delivery count), and `MAXLEN ~` trimming drops the oldest entries.

interface PendingEntry {
    consumer: string;
    deliveredAt: number;
    deliveries: number;
}

interface Group {
    lastDeliveredIndex: number;
    pending: Map<string, PendingEntry>;
}

export class FakeRedisStream {
    public entries: { id: string; message: Record<string, string> }[] = [];
    public groups: Map<string, Group> = new Map();
    public now: number = 1_000_000;
    private sequence: number = 0;
    /** Makes the next call of the named command reject with this error. */
    public failNext: Map<string, Error> = new Map();

    private maybeFail(command: string): void {
        const err: Error | undefined = this.failNext.get(command);
        if (err) {
            this.failNext.delete(command);
            throw err;
        }
    }

    public async xAdd(_key: string, _id: string, message: Record<string, string>, options?: any): Promise<string> {
        this.maybeFail("xAdd");
        const id: string = `${this.now}-${this.sequence++}`;
        this.entries.push({ id, message });
        const threshold: number | undefined = options?.TRIM?.threshold;
        if (threshold !== undefined && this.entries.length > threshold) {
            this.entries.splice(0, this.entries.length - threshold);
        }
        return id;
    }

    public async xGroupCreate(_key: string, group: string, id: string, _options?: any): Promise<string> {
        this.maybeFail("xGroupCreate");
        if (this.groups.has(group)) {
            throw new Error("BUSYGROUP Consumer Group name already exists");
        }
        this.groups.set(group, { lastDeliveredIndex: id === "$" ? this.entries.length - 1 : -1, pending: new Map() });
        return "OK";
    }

    public async xReadGroup(group: string, consumer: string, _streams: { key: string; id: string }, options?: any): Promise<any> {
        this.maybeFail("xReadGroup");
        const state: Group = this.groups.get(group)!;
        const next = this.entries.slice(state.lastDeliveredIndex + 1, state.lastDeliveredIndex + 1 + (options?.COUNT ?? Infinity));
        if (next.length === 0) {
            return null;
        }
        state.lastDeliveredIndex += next.length;
        for (const entry of next) {
            state.pending.set(entry.id, { consumer, deliveredAt: this.now, deliveries: 1 });
        }
        return [{ name: "stream", messages: next }];
    }

    public async xAck(_key: string, group: string, id: string | string[]): Promise<number> {
        const ids: string[] = Array.isArray(id) ? id : [id];
        let acked: number = 0;
        for (const one of ids) {
            acked += this.groups.get(group)!.pending.delete(one) ? 1 : 0;
        }
        return acked;
    }

    public async xPendingRange(_key: string, group: string, _start: string, _end: string, count: number, options?: any): Promise<any[]> {
        return [...this.groups.get(group)!.pending.entries()]
            .filter(([, entry]) => this.now - entry.deliveredAt >= (options?.IDLE ?? 0))
            .slice(0, count)
            .map(([id, entry]) => ({ id, consumer: entry.consumer, millisecondsSinceLastDelivery: this.now - entry.deliveredAt, deliveriesCounter: entry.deliveries }));
    }

    public async xAutoClaim(_key: string, group: string, consumer: string, minIdleTime: number, _start: string, options?: any): Promise<any> {
        const messages: any[] = [];
        for (const [id, entry] of this.groups.get(group)!.pending.entries()) {
            if (messages.length >= (options?.COUNT ?? Infinity) || this.now - entry.deliveredAt < minIdleTime) {
                continue;
            }
            entry.consumer = consumer;
            entry.deliveredAt = this.now;
            entry.deliveries++;
            // A claimed entry trimmed from the stream comes back as null, as XAUTOCLAIM does.
            messages.push(this.entries.find((candidate) => candidate.id === id) ?? null);
        }
        return { nextId: "0-0", messages, deletedMessages: [] };
    }
}
