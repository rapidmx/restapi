///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Unit tests for the correspondent bookkeeping. The repositories are hand-built (an in-memory table that understands the
// few query shapes used) so the races and failures a real datastore can't be made to produce on demand - a lost version
// race, a duplicate-key create, a failing read - are covered. The same code against real MongoDB and SQL runs through
// `test/routes/{mongo,sql}/DirectoryRoute.test.ts` and the ingest, send and calendar route and job tests.
import { ModelUtils, RepoUtils } from "@rapidrest/service-core";
import {
    CORRESPONDENT_BACKFILL_MAX_ADDRESSES,
    CORRESPONDENT_MAX_ADDRESS_LENGTH,
    CORRESPONDENT_MAX_NAME_LENGTH,
    CORRESPONDENT_MAX_PER_CALL,
    cleanCorrespondentAddress,
    ensureCorrespondentsBackfilled,
    eventObservations,
    mergeCorrespondentObservations,
    messageObservations,
    recordCorrespondents,
    type CorrespondentBackfillContext,
} from "../../src/util/CorrespondentUtils.js";
import { FolderType } from "../../src/models/types.js";

class CorrespondentClass {
    constructor(other: any) {
        Object.assign(this, { uid: `c${CorrespondentClass.next++}`, version: 0 }, other);
    }
    static next = 1;
}
class MailboxClass {}
class MessageClass {}
class FolderClass {}
class EventClass {}

/** The value(s) a query field asks for: a plain value, or a `ModelUtils.literal()` (`eq` or `in`). */
function wanted(field: any): any[] | undefined {
    if (field === undefined) {
        return undefined;
    }
    const value: any = field?.value !== undefined ? field.value : field;
    return Array.isArray(value) ? value : [value];
}

/** An in-memory table with the parts of `RepoUtils` the util uses. `hooks` lets a test fail a call. */
class FakeRepo {
    public rows: any[] = [];
    public hooks: { create?: (obj: any) => void; update?: (patch: any) => void; find?: () => void; findOne?: () => void } = {};
    public updates: any[] = [];
    public queries: any[] = [];
    public findOptions: any[] = [];

    constructor(rows: any[] = []) {
        this.rows = rows;
    }

    async find(query: any, options?: any): Promise<any[]> {
        this.queries.push(query);
        this.findOptions.push(options);
        this.hooks.find?.();
        let matches = this.rows.filter((row) =>
            ["uid", "mailboxUid", "address"].every((key) => {
                const values = wanted(query[key]);
                return values === undefined || values.includes(row[key]);
            }),
        );
        if (query.sort?.receivedDate === "DESC") {
            matches = [...matches].sort((a, b) => +new Date(b.receivedDate) - +new Date(a.receivedDate));
        }
        return matches.slice(0, query.limit ?? 100).map((row) => ({ ...row }));
    }

    async findOne(uid: string): Promise<any> {
        this.hooks.findOne?.();
        const row = this.rows.find((candidate) => candidate.uid === uid);
        return row ? { ...row } : undefined;
    }

    async create(obj: any): Promise<any> {
        this.hooks.create?.(obj);
        const row = { ...obj, version: 0 };
        this.rows.push(row);
        return row;
    }

    async update(patch: any, existing: any): Promise<any> {
        this.updates.push({ patch, existing });
        this.hooks.update?.(patch);
        const row = this.rows.find((candidate) => candidate.uid === patch.uid);
        if (!row || row.version !== patch.version) {
            throw Object.assign(new Error("version conflict"), { status: 409 });
        }
        Object.assign(row, patch, { version: row.version + 1 });
        return { ...row };
    }
}

function fixture() {
    const repos: Record<string, FakeRepo> = {
        CorrespondentClass: new FakeRepo(),
        MailboxClass: new FakeRepo(),
        MessageClass: new FakeRepo(),
        FolderClass: new FakeRepo(),
        EventClass: new FakeRepo(),
    };
    const objectFactory: any = {
        newInstance: vi.fn(async (clazz: any, options: any) => {
            expect(clazz).toBe(RepoUtils);
            const repo = repos[options.name];
            if (!repo) {
                throw new Error(`no repo ${options.name}`);
            }
            return repo;
        }),
    };
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const context: CorrespondentBackfillContext = {
        objectFactory,
        correspondentClass: CorrespondentClass,
        mailboxClass: MailboxClass,
        messageClass: MessageClass,
        folderClass: FolderClass,
        calendarEventClass: EventClass,
        logger,
    };
    const mailbox = { uid: "mb1", primarySmtpAddress: "Me@Example.com", aliasAddresses: ["alias@example.com"] };
    repos.MailboxClass.rows.push({ ...mailbox, version: 0 });
    return { repos, context, logger, mailbox, objectFactory };
}

const at = (iso: string): Date => new Date(iso);

describe("cleanCorrespondentAddress()", () => {
    it("lowercases and trims a plain address", () => {
        expect(cleanCorrespondentAddress("  Alice@Example.COM ")).toBe("alice@example.com");
        expect(cleanCorrespondentAddress("a+tag@sub.example.com")).toBe("a+tag@sub.example.com");
    });

    it.each([undefined, null, 5, "", "   ", "no-at-sign", "a@b", "a b@example.com", "<a@example.com>", "a@@example.com", "a@exa,mple.com", 'a"b@example.com'])(
        "rejects %j",
        (value) => {
            expect(cleanCorrespondentAddress(value)).toBeUndefined();
        },
    );

    it("rejects an address longer than the limit", () => {
        const longest = `${"a".repeat(CORRESPONDENT_MAX_ADDRESS_LENGTH - "@example.com".length)}@example.com`;
        expect(cleanCorrespondentAddress(longest)).toBe(longest);
        expect(cleanCorrespondentAddress(`a${longest}`)).toBeUndefined();
    });
});

describe("mergeCorrespondentObservations()", () => {
    const own = { primarySmtpAddress: "Me@Example.com", aliasAddresses: ["alias@example.com"] };
    const now = at("2026-01-01T00:00:00Z");

    it("skips the mailbox's own primary address and aliases, and anything that is not an address", () => {
        const merged = mergeCorrespondentObservations(
            own,
            [{ address: "ME@example.com" }, { address: "Alias@Example.com" }, { address: "bogus" }, { address: null }, { address: "bob@example.com" }, undefined as any],
            "received",
            now,
        );
        expect([...merged.keys()]).toEqual(["bob@example.com"]);
    });

    it("tolerates a mailbox without aliases or with a missing primary address", () => {
        expect([...mergeCorrespondentObservations({ primarySmtpAddress: undefined as any, aliasAddresses: undefined as any }, [{ address: "a@b.co" }], "sent", now).keys()]).toEqual(["a@b.co"]);
    });

    it("counts an address once per merge however often it is listed, unless counts are given", () => {
        const implicit = mergeCorrespondentObservations(own, [{ address: "a@b.co" }, { address: "A@b.co" }], "sent", now);
        expect(implicit.get("a@b.co")).toMatchObject({ count: 1, seenAt: now, source: "sent" });

        const explicit = mergeCorrespondentObservations(own, [{ address: "a@b.co", count: 3 }, { address: "a@b.co", count: 2.9 }, { address: "a@b.co" }], "sent", now);
        expect(explicit.get("a@b.co")!.count).toBe(6);

        // A count that is not a positive number is no count at all.
        const bad = mergeCorrespondentObservations(own, [{ address: "a@b.co", count: 0 }, { address: "a@b.co", count: NaN }, { address: "a@b.co", count: -4 }], "sent", now);
        expect(bad.get("a@b.co")!.count).toBe(1);
    });

    it("keeps the latest sighting's time and source, and the latest non-empty name (later in the list wins a tie)", () => {
        const merged = mergeCorrespondentObservations(
            own,
            [
                { address: "a@b.co", displayName: "Old Name", seenAt: at("2026-01-01T00:00:00Z"), source: "received" },
                { address: "a@b.co", displayName: "Newest Name", seenAt: at("2026-03-01T00:00:00Z"), source: "event" },
                { address: "a@b.co", displayName: "Middle Name", seenAt: at("2026-02-01T00:00:00Z"), source: "sent" },
                { address: "a@b.co", displayName: "", seenAt: at("2026-04-01T00:00:00Z") },
                { address: "c@d.co", displayName: "First", seenAt: at("2026-01-01T00:00:00Z") },
                { address: "c@d.co", displayName: "Second", seenAt: at("2026-01-01T00:00:00Z") },
            ],
            "received",
            now,
        );
        expect(merged.get("a@b.co")).toEqual({ displayName: "Newest Name", seenAt: at("2026-04-01T00:00:00Z"), count: 1, source: "received" });
        expect(merged.get("c@d.co")!.displayName).toBe("Second");
    });

    it("cleans names, and treats an invalid seenAt as now", () => {
        const merged = mergeCorrespondentObservations(
            own,
            [
                { address: "a@b.co", displayName: "  Alice\r\n  Smith\u0000 ", seenAt: new Date("nope") },
                { address: "c@d.co", displayName: "x".repeat(CORRESPONDENT_MAX_NAME_LENGTH + 50) },
                { address: "e@f.co", displayName: 12 as any, seenAt: "2026-02-02T00:00:00Z" as any },
            ],
            "received",
            now,
        );
        expect(merged.get("a@b.co")).toMatchObject({ displayName: "Alice Smith", seenAt: now });
        expect(merged.get("c@d.co")!.displayName).toHaveLength(CORRESPONDENT_MAX_NAME_LENGTH);
        expect(merged.get("e@f.co")).toMatchObject({ displayName: "", seenAt: at("2026-02-02T00:00:00Z") });
    });

    it("keeps at most maxAddresses distinct addresses, the first ones listed, but still merges later sightings of those", () => {
        const merged = mergeCorrespondentObservations(
            own,
            [{ address: "a@b.co" }, { address: "c@d.co" }, { address: "e@f.co" }, { address: "a@b.co", displayName: "A" }],
            "received",
            now,
            2,
        );
        expect([...merged.keys()]).toEqual(["a@b.co", "c@d.co"]);
        expect(merged.get("a@b.co")!.displayName).toBe("A");
        expect(mergeCorrespondentObservations(own, [], "sent", now).size).toBe(0);
        const many = Array.from({ length: CORRESPONDENT_MAX_PER_CALL + 5 }, (_, i) => ({ address: `p${i}@b.co` }));
        expect(mergeCorrespondentObservations(own, many, "sent", now).size).toBe(CORRESPONDENT_MAX_PER_CALL);
    });
});

describe("messageObservations() and eventObservations()", () => {
    it("lists the sender when asked, and the recipients of the named types (a missing type counts as to)", () => {
        const message = {
            from: { address: "from@x.co", displayName: "From" },
            recipients: [
                { address: "to@x.co", displayName: "To", type: "to" },
                { address: "cc@x.co", type: "cc" },
                { address: "bcc@x.co", type: "bcc" },
                { address: "untyped@x.co" },
                undefined as any,
            ],
        };
        expect(messageObservations(message, { from: true, types: ["to", "cc"] }).map((o) => o.address)).toEqual(["from@x.co", "to@x.co", "cc@x.co", "untyped@x.co", undefined]);
        expect(messageObservations(message, { from: false, types: ["bcc"] })).toEqual([{ address: "bcc@x.co", displayName: undefined }]);
        expect(messageObservations({}, { from: true, types: ["to"] })).toEqual([]);
    });

    it("lists an event's organizer and attendees", () => {
        expect(
            eventObservations({ organizer: { address: "o@x.co", displayName: "Org" }, attendees: [{ address: "a@x.co" }, undefined as any] }),
        ).toEqual([
            { address: "o@x.co", displayName: "Org" },
            { address: "a@x.co", displayName: undefined },
            { address: undefined, displayName: undefined },
        ]);
        expect(eventObservations({})).toEqual([{ address: undefined, displayName: undefined }]);
    });
});

describe("recordCorrespondents()", () => {
    it("creates a row per distinct address, lowercased, skipping the mailbox's own addresses", async () => {
        const { repos, context, mailbox } = fixture();
        await recordCorrespondents(
            context,
            mailbox,
            [{ address: "Bob@Example.com", displayName: "Bob" }, { address: "me@example.com" }, { address: "alias@example.com" }, { address: "bob@example.com" }, { address: "junk" }],
            "received",
        );
        expect(repos.CorrespondentClass.rows).toHaveLength(1);
        expect(repos.CorrespondentClass.rows[0]).toMatchObject({ mailboxUid: "mb1", address: "bob@example.com", displayName: "Bob", count: 1, lastSource: "received" });
        expect(repos.CorrespondentClass.rows[0].lastSeenAt).toBeInstanceOf(Date);
    });

    it("loads the mailbox when given its uid, and records nothing for one that is gone or for no observations", async () => {
        const { repos, context, objectFactory } = fixture();
        await recordCorrespondents(context, "mb1", [{ address: "bob@example.com" }, { address: "me@example.com" }], "sent");
        expect(repos.CorrespondentClass.rows.map((row) => row.address)).toEqual(["bob@example.com"]);

        repos.CorrespondentClass.rows.length = 0;
        await recordCorrespondents(context, "gone", [{ address: "bob@example.com" }], "sent");
        expect(repos.CorrespondentClass.rows).toEqual([]);

        objectFactory.newInstance.mockClear();
        await recordCorrespondents(context, "mb1", [], "sent");
        expect(objectFactory.newInstance).not.toHaveBeenCalled();
    });

    it("adds one to the count of a known address and moves it forward, keeping its name when the new sighting has none", async () => {
        const { repos, context, mailbox } = fixture();
        await recordCorrespondents(context, mailbox, [{ address: "bob@example.com", displayName: "Bob", seenAt: at("2026-01-01T00:00:00Z") }], "received");
        await recordCorrespondents(context, mailbox, [{ address: "bob@example.com", seenAt: at("2026-02-01T00:00:00Z") }], "sent");
        expect(repos.CorrespondentClass.rows).toHaveLength(1);
        expect(repos.CorrespondentClass.rows[0]).toMatchObject({ displayName: "Bob", count: 2, lastSource: "sent", lastSeenAt: at("2026-02-01T00:00:00Z") });

        await recordCorrespondents(context, mailbox, [{ address: "bob@example.com", displayName: "Robert", seenAt: at("2026-03-01T00:00:00Z") }], "event");
        expect(repos.CorrespondentClass.rows[0]).toMatchObject({ displayName: "Robert", count: 3, lastSource: "event" });
    });

    it("counts an older sighting without letting it change who the address is now", async () => {
        const { repos, context, mailbox } = fixture();
        await recordCorrespondents(context, mailbox, [{ address: "bob@example.com", displayName: "Robert", seenAt: at("2026-03-01T00:00:00Z") }], "sent");
        await recordCorrespondents(context, mailbox, [{ address: "bob@example.com", displayName: "Bob", seenAt: at("2026-01-01T00:00:00Z"), count: 4 }], "received");
        expect(repos.CorrespondentClass.rows[0]).toMatchObject({ displayName: "Robert", count: 5, lastSource: "sent", lastSeenAt: at("2026-03-01T00:00:00Z") });
    });

    it("copes with a stored row that has no usable count, time or name", async () => {
        const { repos, context, mailbox } = fixture();
        repos.CorrespondentClass.rows.push({ uid: "old", version: 0, mailboxUid: "mb1", address: "bob@example.com", count: undefined, lastSeenAt: "garbage", displayName: undefined });
        await recordCorrespondents(context, mailbox, [{ address: "bob@example.com" }], "received");
        expect(repos.CorrespondentClass.rows[0]).toMatchObject({ count: 1, lastSource: "received", displayName: "" });
        expect(repos.CorrespondentClass.rows[0].lastSeenAt).toBeInstanceOf(Date);
    });

    it("reads the existing rows once, however many addresses", async () => {
        const { repos, context, mailbox } = fixture();
        await recordCorrespondents(
            context,
            mailbox,
            Array.from({ length: 25 }, (_, i) => ({ address: `p${i}@example.com` })),
            "received",
        );
        expect(repos.CorrespondentClass.rows).toHaveLength(25);
        expect(repos.CorrespondentClass.queries).toHaveLength(1);
    });

    it("retries a create that lost a race to another writer, against the row that won", async () => {
        const { repos, context, mailbox } = fixture();
        let raced = false;
        repos.CorrespondentClass.hooks.create = () => {
            if (!raced) {
                raced = true;
                repos.CorrespondentClass.rows.push({ uid: "winner", version: 0, mailboxUid: "mb1", address: "bob@example.com", displayName: "", count: 1, lastSeenAt: at("2020-01-01T00:00:00Z"), lastSource: "received" });
                throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
            }
        };
        await recordCorrespondents(context, mailbox, [{ address: "bob@example.com" }], "sent");
        expect(repos.CorrespondentClass.rows).toHaveLength(1);
        expect(repos.CorrespondentClass.rows[0]).toMatchObject({ uid: "winner", count: 2, lastSource: "sent" });
    });

    it("retries an update that lost a version race", async () => {
        const { repos, context, mailbox } = fixture();
        await recordCorrespondents(context, mailbox, [{ address: "bob@example.com" }], "received");
        let raced = false;
        repos.CorrespondentClass.hooks.update = () => {
            if (!raced) {
                raced = true;
                repos.CorrespondentClass.rows[0].version += 1;
            }
        };
        await recordCorrespondents(context, mailbox, [{ address: "bob@example.com" }], "received");
        expect(repos.CorrespondentClass.rows[0].count).toBe(2);
    });

    it("gives up on an address after three lost races, logs it, and still records the others", async () => {
        const { repos, context, mailbox, logger } = fixture();
        repos.CorrespondentClass.hooks.create = (obj: any) => {
            if (obj.address === "bad@example.com") {
                throw Object.assign(new Error("duplicate key"), { code: 11000 });
            }
        };
        await recordCorrespondents(context, mailbox, [{ address: "bad@example.com" }, { address: "good@example.com" }], "received");
        expect(repos.CorrespondentClass.rows.map((row) => row.address)).toEqual(["good@example.com"]);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("could not record bad@example.com for mailbox mb1"));
    });

    it("does not retry an error that is not a lost race", async () => {
        const { repos, context, mailbox, logger } = fixture();
        const create = vi.fn(() => {
            throw new Error("disk on fire");
        });
        repos.CorrespondentClass.hooks.create = create;
        await recordCorrespondents(context, mailbox, [{ address: "bad@example.com" }], "received");
        expect(create).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("disk on fire"));
    });

    it("never throws: a failing read, an unknown repo and a missing logger are all swallowed", async () => {
        const { repos, context, mailbox, logger } = fixture();
        repos.CorrespondentClass.hooks.find = () => {
            throw new Error("read failed");
        };
        await expect(recordCorrespondents(context, mailbox, [{ address: "bob@example.com" }], "received")).resolves.toBeUndefined();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("read failed"));

        class Unregistered {}
        await expect(recordCorrespondents({ ...context, correspondentClass: Unregistered }, mailbox, [{ address: "bob@example.com" }], "received")).resolves.toBeUndefined();
        await expect(recordCorrespondents({ ...context, logger: undefined, correspondentClass: Unregistered }, mailbox, [{ address: "bob@example.com" }], "received")).resolves.toBeUndefined();

        repos.CorrespondentClass.hooks.find = () => {
            throw new Error("still failing");
        };
        await expect(recordCorrespondents({ ...context, logger: undefined }, mailbox, [{ address: "bob@example.com" }], "received")).resolves.toBeUndefined();
        // A per-address failure with no logger is swallowed too.
        repos.CorrespondentClass.hooks.find = undefined;
        repos.CorrespondentClass.hooks.create = () => {
            throw new Error("nope");
        };
        await expect(recordCorrespondents({ ...context, logger: undefined }, mailbox, [{ address: "bob@example.com" }], "received")).resolves.toBeUndefined();
    });
});

describe("ensureCorrespondentsBackfilled()", () => {
    const folders = (repos: Record<string, FakeRepo>): void => {
        repos.FolderClass.rows.push(
            { uid: "inbox", mailboxUid: "mb1", type: FolderType.INBOX },
            { uid: "sent", mailboxUid: "mb1", type: FolderType.SENT_ITEMS },
            { uid: "junk", mailboxUid: "mb1", type: FolderType.JUNK },
            { uid: "drafts", mailboxUid: "mb1", type: FolderType.DRAFTS },
            { uid: "trash", mailboxUid: "mb1", type: FolderType.DELETED_ITEMS },
            { uid: "outbox", mailboxUid: "mb1", type: FolderType.OUTBOX },
            { uid: "other-mailbox", mailboxUid: "mb2", type: FolderType.INBOX },
        );
    };
    const message = (uid: string, folderUid: string, from: string, recipients: [string, string, string?][], receivedDate: string, extra: any = {}) => ({
        uid,
        mailboxUid: "mb1",
        folderUid,
        from: { address: from, displayName: from.split("@")[0] },
        recipients: recipients.map(([address, type, displayName]) => ({ address, type, displayName })),
        receivedDate: at(receivedDate),
        ...extra,
    });

    it("builds the list from received and sent mail and calendar events, leaving out junk, drafts, deleted items and the outbox", async () => {
        const { repos, context, mailbox } = fixture();
        folders(repos);
        repos.MessageClass.rows.push(
            message("m1", "inbox", "Carol@Example.com", [["me@example.com", "to"], ["dave@example.com", "cc", "Dave D"], ["hidden@example.com", "bcc"]], "2026-01-01T00:00:00Z"),
            message("m2", "inbox", "carol@example.com", [["alias@example.com", "to"]], "2026-02-01T00:00:00Z"),
            message("m3", "sent", "me@example.com", [["erin@example.com", "to", "Erin"], ["frank@example.com", "bcc"]], "2026-01-15T00:00:00Z"),
            message("m4", "junk", "spam@example.com", [["me@example.com", "to"]], "2026-03-01T00:00:00Z"),
            message("m5", "drafts", "me@example.com", [["draft@example.com", "to"]], "2026-03-01T00:00:00Z"),
            message("m6", "trash", "trash@example.com", [["me@example.com", "to"]], "2026-03-01T00:00:00Z"),
            message("m7", "outbox", "me@example.com", [["queued@example.com", "to"]], "2026-03-01T00:00:00Z"),
            // No received date: falls back to the sent date, then the creation date; a message with neither is dated now.
            message("m8", "inbox", "gina@example.com", [], "2026-01-01T00:00:00Z", { receivedDate: undefined, sentDate: at("2025-06-01T00:00:00Z") }),
            message("m9", "inbox", "hank@example.com", [], "2026-01-01T00:00:00Z", { receivedDate: undefined, dateCreated: at("2025-05-01T00:00:00Z") }),
            message("m10", "inbox", "ivy@example.com", [], "2026-01-01T00:00:00Z", { receivedDate: undefined }),
        );
        repos.EventClass.rows.push(
            { uid: "e1", mailboxUid: "mb1", organizer: { address: "org@example.com", displayName: "Org" }, attendees: [{ address: "me@example.com" }, { address: "guest@example.com" }], dateModified: at("2026-02-15T00:00:00Z") },
            { uid: "e2", mailboxUid: "mb1", organizer: { address: "me@example.com" }, attendees: [{ address: "guest@example.com", displayName: "Guest" }], dateCreated: at("2026-01-20T00:00:00Z") },
            { uid: "e3", mailboxUid: "mb1", organizer: { address: "late@example.com" }, attendees: [] },
        );

        await ensureCorrespondentsBackfilled(context, mailbox);

        const byAddress = new Map(repos.CorrespondentClass.rows.map((row) => [row.address, row]));
        expect([...byAddress.keys()].sort()).toEqual(
            [
                "carol@example.com",
                "dave@example.com",
                "erin@example.com",
                "frank@example.com",
                "gina@example.com",
                "guest@example.com",
                "hank@example.com",
                "ivy@example.com",
                "late@example.com",
                "org@example.com",
            ].sort(),
        );
        // Two received messages from Carol, the newest dated 2026-02-01; recipients of received mail are To and Cc only.
        expect(byAddress.get("carol@example.com")).toMatchObject({ count: 2, lastSource: "received", lastSeenAt: at("2026-02-01T00:00:00Z"), displayName: "carol" });
        expect(byAddress.get("dave@example.com")).toMatchObject({ count: 1, displayName: "Dave D", lastSource: "received" });
        // Sent mail contributes its recipients including Bcc.
        expect(byAddress.get("erin@example.com")).toMatchObject({ count: 1, lastSource: "sent", displayName: "Erin" });
        expect(byAddress.get("frank@example.com")).toMatchObject({ lastSource: "sent" });
        expect(byAddress.get("gina@example.com")!.lastSeenAt).toEqual(at("2025-06-01T00:00:00Z"));
        expect(byAddress.get("hank@example.com")!.lastSeenAt).toEqual(at("2025-05-01T00:00:00Z"));
        expect(byAddress.get("ivy@example.com")!.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
        // Events: one sighting each, the newest name wins.
        expect(byAddress.get("guest@example.com")).toMatchObject({ count: 2, lastSource: "event", displayName: "Guest" });
        expect(byAddress.get("org@example.com")).toMatchObject({ count: 1, lastSource: "event", displayName: "Org" });
        expect(byAddress.get("late@example.com")).toMatchObject({ count: 1, lastSource: "event" });

        // Marked done, so a second call does nothing.
        expect(repos.MailboxClass.rows[0].correspondentsBackfilledAt).toBeInstanceOf(Date);
        const before = repos.CorrespondentClass.rows.map((row) => ({ ...row }));
        await ensureCorrespondentsBackfilled(context, { ...mailbox, correspondentsBackfilledAt: new Date() });
        await ensureCorrespondentsBackfilled(context, mailbox);
        expect(repos.CorrespondentClass.rows).toEqual(before);
    });

    it("adds to correspondents recorded live before it ran", async () => {
        const { repos, context, mailbox } = fixture();
        folders(repos);
        repos.MessageClass.rows.push(message("m1", "inbox", "carol@example.com", [], "2026-01-01T00:00:00Z"));
        await recordCorrespondents(context, mailbox, [{ address: "carol@example.com", displayName: "Live Carol" }], "received");
        await ensureCorrespondentsBackfilled(context, mailbox);
        expect(repos.CorrespondentClass.rows).toHaveLength(1);
        // The live sighting is newer than the message the backfill found, so it keeps the name and time.
        expect(repos.CorrespondentClass.rows[0]).toMatchObject({ count: 2, displayName: "Live Carol" });
    });

    it("keeps only the most recently seen addresses when there are more than the cap", async () => {
        const { repos, context, mailbox } = fixture();
        folders(repos);
        const total = CORRESPONDENT_BACKFILL_MAX_ADDRESSES + 3;
        for (let i = 0; i < total; i++) {
            repos.MessageClass.rows.push(message(`bulk${i}`, "inbox", `p${i}@example.com`, [], new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString()));
        }
        await ensureCorrespondentsBackfilled(context, mailbox);
        expect(repos.CorrespondentClass.rows).toHaveLength(CORRESPONDENT_BACKFILL_MAX_ADDRESSES);
        expect(repos.CorrespondentClass.rows.some((row) => row.address === `p${total - 1}@example.com`)).toBe(true);
        expect(repos.CorrespondentClass.rows.some((row) => row.address === "p0@example.com")).toBe(false);
    });

    it("does nothing for a mailbox that is gone or was marked done since the caller read it", async () => {
        const { repos, context, mailbox } = fixture();
        await ensureCorrespondentsBackfilled(context, { ...mailbox, uid: "gone" });
        repos.MailboxClass.rows[0].correspondentsBackfilledAt = new Date();
        const version = repos.MailboxClass.rows[0].version;
        await ensureCorrespondentsBackfilled(context, mailbox);
        expect(repos.MailboxClass.rows[0].version).toBe(version);
        expect(repos.MessageClass.queries).toEqual([]);
    });

    it("leaves the work to whoever claimed it first when the claim loses a version race", async () => {
        const { repos, context, mailbox, logger } = fixture();
        repos.MailboxClass.hooks.update = () => {
            repos.MailboxClass.rows[0].version += 1;
        };
        await ensureCorrespondentsBackfilled(context, mailbox);
        expect(repos.MessageClass.queries).toEqual([]);
        expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("claimed elsewhere"));
        // No logger at all is fine too.
        await ensureCorrespondentsBackfilled({ ...context, logger: undefined }, mailbox);
        await ensureCorrespondentsBackfilled({ ...context, logger: { warn: vi.fn() } }, mailbox);
    });

    it("clears the marker again when the backfill fails, so the next search retries", async () => {
        const { repos, context, mailbox, logger } = fixture();
        repos.MessageClass.hooks.find = () => {
            throw new Error("messages unreadable");
        };
        await ensureCorrespondentsBackfilled(context, mailbox);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("messages unreadable"));
        expect(repos.MailboxClass.rows[0].correspondentsBackfilledAt).toBeNull();
        repos.MessageClass.hooks.find = undefined;
        await ensureCorrespondentsBackfilled(context, { ...mailbox, correspondentsBackfilledAt: undefined });
        expect(repos.MailboxClass.rows[0].correspondentsBackfilledAt).toBeInstanceOf(Date);
    });

    it("survives a failure while clearing the marker", async () => {
        const { repos, context, mailbox } = fixture();
        repos.MessageClass.hooks.find = () => {
            throw new Error("messages unreadable");
        };
        let calls = 0;
        repos.MailboxClass.hooks.findOne = () => {
            if (++calls > 1) {
                throw new Error("mailbox unreadable");
            }
        };
        await expect(ensureCorrespondentsBackfilled(context, mailbox)).resolves.toBeUndefined();
        expect(repos.MailboxClass.rows[0].correspondentsBackfilledAt).toBeInstanceOf(Date);
    });

    it("survives the mailbox vanishing while the marker is cleared", async () => {
        const { repos, context, mailbox } = fixture();
        repos.MessageClass.hooks.find = () => {
            repos.MailboxClass.rows.length = 0;
            throw new Error("messages unreadable");
        };
        await expect(ensureCorrespondentsBackfilled(context, mailbox)).resolves.toBeUndefined();
    });

    it("never throws when the mailbox cannot be read at all", async () => {
        const { repos, context, mailbox, logger } = fixture();
        repos.MailboxClass.hooks.findOne = () => {
            throw new Error("mailbox unreadable");
        };
        await expect(ensureCorrespondentsBackfilled(context, mailbox)).resolves.toBeUndefined();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("mailbox unreadable"));
        await expect(ensureCorrespondentsBackfilled({ ...context, logger: undefined }, mailbox)).resolves.toBeUndefined();
    });

    it("reads the query values the way the datastores do", () => {
        expect(wanted(ModelUtils.literal("a"))).toEqual(["a"]);
        expect(wanted(ModelUtils.literal(["a", "b"], "in"))).toEqual(["a", "b"]);
    });
});
