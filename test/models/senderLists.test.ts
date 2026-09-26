///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Constructor behaviour of the Mailbox sender lists (`blockedSenders`, `safeSenders`) and the Message report fields (`reportedAs`,
// `dateReported`), on both backends' model classes.
import { MailboxMongo } from "../../src/models/mongo/MailboxMongo.js";
import { MessageMongo } from "../../src/models/mongo/MessageMongo.js";
import { MailboxSQL } from "../../src/models/sql/MailboxSQL.js";
import { MessageSQL } from "../../src/models/sql/MessageSQL.js";

describe.each([
    ["Mongo", MailboxMongo, MessageMongo],
    ["SQL", MailboxSQL, MessageSQL],
] as const)("%s sender list and report fields", (_backend, Mailbox, Message) => {
    it("A mailbox starts with empty blocked and safe sender lists.", () => {
        const empty: any = new Mailbox();
        const partial: any = new Mailbox({ displayName: "Only a name" });

        expect(empty.blockedSenders).toEqual([]);
        expect(empty.safeSenders).toEqual([]);
        expect(partial.blockedSenders).toEqual([]);
        expect(partial.safeSenders).toEqual([]);
    });

    it("A mailbox takes the lists it is given, and keeps each default when only the other is given.", () => {
        const both: any = new Mailbox({ blockedSenders: ["a@x.example", "@bad.example"], safeSenders: ["b@x.example"] });
        const onlyBlocked: any = new Mailbox({ blockedSenders: ["a@x.example"] });
        const onlySafe: any = new Mailbox({ safeSenders: ["b@x.example"] });

        expect(both.blockedSenders).toEqual(["a@x.example", "@bad.example"]);
        expect(both.safeSenders).toEqual(["b@x.example"]);
        expect(onlyBlocked.safeSenders).toEqual([]);
        expect(onlySafe.blockedSenders).toEqual([]);
    });

    it("A mailbox keeps a null list - what a SQL row from before the columns reads as.", () => {
        const legacy: any = new Mailbox({ blockedSenders: null, safeSenders: null } as any);

        expect(legacy.blockedSenders).toBeNull();
        expect(legacy.safeSenders).toBeNull();
    });

    it("A message has never been reported by default.", () => {
        const empty: any = new Message();
        const partial: any = new Message({ subject: "Hello" });

        expect(empty.reportedAs).toBeUndefined();
        expect(empty.dateReported).toBeUndefined();
        expect(partial.reportedAs).toBeUndefined();
        expect(partial.dateReported).toBeUndefined();
    });

    it("A message takes the report it is given, including a cleared one (null).", () => {
        const when = new Date("2026-09-25T12:00:00Z");
        const reported: any = new Message({ reportedAs: "phishing", dateReported: when });
        const cleared: any = new Message({ reportedAs: null, dateReported: null } as any);

        expect(reported.reportedAs).toBe("phishing");
        expect(reported.dateReported).toBe(when);
        expect(cleared.reportedAs).toBeNull();
        expect(cleared.dateReported).toBeNull();
    });
});
