///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The mailbox's Blocked Senders and Safe Senders lists, and the exact-match sender conditions of a mail filter rule, through
// `ScanQueueJob` - identical on both backends. `test/jobs/{mongo,sql}/ScanQueueJob*.test.ts` supply the real job over a real datastore,
// a real `ScanPipeline`, and spam/AV doubles that read `X-Test-Force-Spam: true` / `X-Test-Force-Infected: true` in the message.
import { AlwaysCleanSpamScanProvider } from "../testDoubles.js";
import { FolderType, MailFilterActionType, QuarantineReason, SpamVerdict } from "../../src/models/types.js";

export interface SenderListsSuiteContext {
    /** Saves the test mailbox (`recipient@example.com`) with `lists`; a list given as `null` is stored as absent/null, as a row from before the columns. */
    setMailbox: (lists?: { blockedSenders?: string[] | null; safeSenders?: string[] | null }) => Promise<void>;
    /** Stores `raw`, queues it for the test mailbox and runs the job once. */
    deliver: (raw: Buffer, options?: { envelopeFrom?: string; quarantineReason?: QuarantineReason }) => Promise<void>;
    /** The messages in the mailbox's folder of `type` (none when it has no such folder). */
    messagesIn: (type: FolderType) => Promise<any[]>;
    scanResultOf: (uid: string) => Promise<any>;
    quarantined: () => Promise<any[]>;
    /** Saves a mail filter rule (sequence 0, enabled) of the test mailbox. */
    saveRule: (fields: Record<string, any>) => Promise<any>;
    /** Saves a user folder of the test mailbox and returns it. */
    saveFolder: (name: string) => Promise<any>;
    messagesInFolder: (folderUid: string) => Promise<any[]>;
}

/** A plain message from `from`. `dkim` is the domain a trusted `Authentication-Results` says passed DKIM (none: unauthenticated). */
function mail(from: string, options: { dkim?: string; spam?: boolean; infected?: boolean; subject?: string } = {}): Buffer {
    return Buffer.from(
        [
            `From: ${from}`,
            "To: recipient@example.com",
            `Subject: ${options.subject ?? "Hello"}`,
            ...(options.dkim ? [`Authentication-Results: mx.example.com; dkim=pass header.d=${options.dkim}`] : []),
            ...(options.spam ? ["X-Test-Force-Spam: true"] : []),
            ...(options.infected ? ["X-Test-Force-Infected: true"] : []),
            "",
            "Body",
            "",
        ].join("\r\n"),
    );
}

export function senderListsSuite(ctx: SenderListsSuiteContext): void {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    const symbolsOf = async (message: any): Promise<string[]> => (await ctx.scanResultOf(message.scanResultUid)).spamSymbols;

    describe("Blocked senders", () => {
        it("files mail from a blocked address in Junk Email, skipping the mailbox's rules, and marks the scan BLOCKED_SENDER.", async () => {
            await ctx.setMailbox({ blockedSenders: ["pest@bad.example"] });
            await ctx.saveRule({ name: "Mark read", conditions: { subjectContains: ["Hello"] }, actions: [{ type: MailFilterActionType.MARK_AS_READ }] });

            await ctx.deliver(mail("Pest <pest@bad.example>"), { envelopeFrom: "pest@bad.example" });

            expect(await ctx.messagesIn(FolderType.INBOX)).toHaveLength(0);
            const junk = await ctx.messagesIn(FolderType.JUNK);
            expect(junk).toHaveLength(1);
            // Junk-routed mail runs no rules.
            expect(junk[0].flags.read).toBe(false);
            expect(await symbolsOf(junk[0])).toEqual(["BLOCKED_SENDER"]);
        });

        it("matches the address case-insensitively, whatever the spelling in the list.", async () => {
            await ctx.setMailbox({ blockedSenders: ["pest@bad.example"] });

            await ctx.deliver(mail("PEST@Bad.Example"), { envelopeFrom: "PEST@BAD.EXAMPLE" });

            expect(await ctx.messagesIn(FolderType.JUNK)).toHaveLength(1);
        });

        it("matches the envelope sender alone, when the From header names somebody else.", async () => {
            await ctx.setMailbox({ blockedSenders: ["bounce@list.example"] });

            await ctx.deliver(mail("Friendly <friend@ok.example>"), { envelopeFrom: "bounce@list.example" });

            expect(await ctx.messagesIn(FolderType.JUNK)).toHaveLength(1);
            expect(await ctx.messagesIn(FolderType.INBOX)).toHaveLength(0);
        });

        it("matches the From header alone, when the envelope sender is somebody else's.", async () => {
            await ctx.setMailbox({ blockedSenders: ["pest@bad.example"] });

            await ctx.deliver(mail("pest@bad.example"), { envelopeFrom: "mailer@relay.example" });

            expect(await ctx.messagesIn(FolderType.JUNK)).toHaveLength(1);
        });

        it("blocks a whole domain, and only that exact domain - a subdomain and a lookalike are not it.", async () => {
            await ctx.setMailbox({ blockedSenders: ["@bad.example"] });

            await ctx.deliver(mail("anyone@bad.example"), { envelopeFrom: "anyone@bad.example" });
            await ctx.deliver(mail("anyone@mail.bad.example"), { envelopeFrom: "anyone@mail.bad.example" });
            await ctx.deliver(mail("anyone@notbad.example"), { envelopeFrom: "anyone@notbad.example" });

            expect((await ctx.messagesIn(FolderType.JUNK)).map((m) => m.from.address)).toEqual(["anyone@bad.example"]);
            expect(await ctx.messagesIn(FolderType.INBOX)).toHaveLength(2);
        });

        it("does not treat an address as its substring: blocking ann@x.example leaves joann@x.example alone.", async () => {
            await ctx.setMailbox({ blockedSenders: ["ann@x.example"] });

            await ctx.deliver(mail("joann@x.example"), { envelopeFrom: "joann@x.example" });

            expect(await ctx.messagesIn(FolderType.INBOX)).toHaveLength(1);
        });

        it("blocks without any authentication - a forged From header is enough to be junked.", async () => {
            await ctx.setMailbox({ blockedSenders: ["pest@bad.example"] });

            await ctx.deliver(mail("pest@bad.example", { dkim: undefined }));

            expect(await ctx.messagesIn(FolderType.JUNK)).toHaveLength(1);
        });

        it("still quarantines an infected message from a blocked sender - a list never turns an antivirus verdict into junk.", async () => {
            await ctx.setMailbox({ blockedSenders: ["pest@bad.example"] });

            await ctx.deliver(mail("pest@bad.example", { infected: true }), { envelopeFrom: "pest@bad.example" });

            expect(await ctx.messagesIn(FolderType.JUNK)).toHaveLength(0);
            expect(await ctx.messagesIn(FolderType.INBOX)).toHaveLength(0);
            const held = await ctx.quarantined();
            expect(held).toHaveLength(1);
            expect(held[0].reason).toBe(QuarantineReason.INFECTED);
        });

        it("leaves a policy quarantine alone.", async () => {
            await ctx.setMailbox({ blockedSenders: ["pest@bad.example"] });

            await ctx.deliver(mail("pest@bad.example"), { envelopeFrom: "pest@bad.example", quarantineReason: QuarantineReason.TRANSPORT_RULE });

            expect(await ctx.messagesIn(FolderType.JUNK)).toHaveLength(0);
            expect((await ctx.quarantined()).map((entry) => entry.reason)).toEqual([QuarantineReason.TRANSPORT_RULE]);
        });

        it("does not add its mark to a message that was already junk for spam, but still files it in Junk.", async () => {
            await ctx.setMailbox({ blockedSenders: ["pest@bad.example"] });

            await ctx.deliver(mail("pest@bad.example", { spam: true }), { envelopeFrom: "pest@bad.example" });

            const junk = await ctx.messagesIn(FolderType.JUNK);
            expect(junk).toHaveLength(1);
            expect(await symbolsOf(junk[0])).toEqual(["TEST_FORCED_SPAM", "BLOCKED_SENDER"]);
        });

        it("delivers as usual to a mailbox whose lists are absent (a row from before they existed) or empty.", async () => {
            await ctx.setMailbox({ blockedSenders: null, safeSenders: null });
            await ctx.deliver(mail("anyone@bad.example"));
            await ctx.setMailbox({ blockedSenders: [], safeSenders: [] });
            await ctx.deliver(mail("anyone@bad.example"));

            expect(await ctx.messagesIn(FolderType.INBOX)).toHaveLength(2);
            expect(await ctx.messagesIn(FolderType.JUNK)).toHaveLength(0);
        });
    });

    describe("Safe senders", () => {
        it("delivers authenticated mail with a spam verdict from a safe address to the Inbox, marks the scan, and runs the rules.", async () => {
            await ctx.setMailbox({ safeSenders: ["friend@ok.example"] });
            await ctx.saveRule({ name: "Mark read", conditions: { subjectContains: ["Hello"] }, actions: [{ type: MailFilterActionType.MARK_AS_READ }] });

            await ctx.deliver(mail("Friend <friend@ok.example>", { dkim: "ok.example", spam: true }), { envelopeFrom: "friend@ok.example" });

            expect(await ctx.messagesIn(FolderType.JUNK)).toHaveLength(0);
            const inbox = await ctx.messagesIn(FolderType.INBOX);
            expect(inbox).toHaveLength(1);
            expect(inbox[0].flags.read).toBe(true);
            expect(await symbolsOf(inbox[0])).toEqual(["TEST_FORCED_SPAM", "SAFE_SENDER"]);
        });

        it("does not rescue the same message when it is not authenticated - the From header may be forged.", async () => {
            await ctx.setMailbox({ safeSenders: ["friend@ok.example"] });

            await ctx.deliver(mail("friend@ok.example", { spam: true }), { envelopeFrom: "friend@ok.example" });

            expect(await ctx.messagesIn(FolderType.INBOX)).toHaveLength(0);
            expect(await ctx.messagesIn(FolderType.JUNK)).toHaveLength(1);
        });

        it("does not rescue a message whose DKIM signature is for another domain than its From address.", async () => {
            await ctx.setMailbox({ safeSenders: ["friend@ok.example"] });

            await ctx.deliver(mail("friend@ok.example", { dkim: "attacker.example", spam: true }), { envelopeFrom: "friend@ok.example" });

            expect(await ctx.messagesIn(FolderType.JUNK)).toHaveLength(1);
        });

        it("does not treat an envelope sender on the safe list as safe: only the From address counts.", async () => {
            await ctx.setMailbox({ safeSenders: ["bounce@list.example"] });

            await ctx.deliver(mail("stranger@other.example", { dkim: "other.example", spam: true }), { envelopeFrom: "bounce@list.example" });

            expect(await ctx.messagesIn(FolderType.JUNK)).toHaveLength(1);
        });

        it("trusts a whole domain, exactly.", async () => {
            await ctx.setMailbox({ safeSenders: ["@ok.example"] });

            await ctx.deliver(mail("anyone@ok.example", { dkim: "ok.example", spam: true }), { envelopeFrom: "anyone@ok.example" });
            await ctx.deliver(mail("anyone@mail.ok.example", { dkim: "mail.ok.example", spam: true }), { envelopeFrom: "anyone@mail.ok.example" });

            expect((await ctx.messagesIn(FolderType.INBOX)).map((m) => m.from.address)).toEqual(["anyone@ok.example"]);
            expect((await ctx.messagesIn(FolderType.JUNK)).map((m) => m.from.address)).toEqual(["anyone@mail.ok.example"]);
        });

        it("never rescues an infected message from a safe, authenticated sender.", async () => {
            await ctx.setMailbox({ safeSenders: ["friend@ok.example"] });

            await ctx.deliver(mail("friend@ok.example", { dkim: "ok.example", infected: true }), { envelopeFrom: "friend@ok.example" });

            expect(await ctx.messagesIn(FolderType.INBOX)).toHaveLength(0);
            expect(await ctx.messagesIn(FolderType.JUNK)).toHaveLength(0);
            expect((await ctx.quarantined()).map((entry) => entry.reason)).toEqual([QuarantineReason.INFECTED]);
        });

        it("never releases a policy quarantine.", async () => {
            await ctx.setMailbox({ safeSenders: ["friend@ok.example"] });

            await ctx.deliver(mail("friend@ok.example", { dkim: "ok.example" }), { envelopeFrom: "friend@ok.example", quarantineReason: QuarantineReason.TRANSPORT_RULE });

            expect(await ctx.messagesIn(FolderType.INBOX)).toHaveLength(0);
            expect(await ctx.quarantined()).toHaveLength(1);
        });

        it("marks nothing on a message the spam filter found clean.", async () => {
            await ctx.setMailbox({ safeSenders: ["friend@ok.example"] });

            await ctx.deliver(mail("friend@ok.example", { dkim: "ok.example" }), { envelopeFrom: "friend@ok.example" });

            const inbox = await ctx.messagesIn(FolderType.INBOX);
            expect(inbox).toHaveLength(1);
            expect(await symbolsOf(inbox[0])).toEqual([]);
        });

        it("delivers a safe, authenticated sender's message through a spam-filter outage's fail-closed verdict.", async () => {
            await ctx.setMailbox({ safeSenders: ["friend@ok.example"] });
            vi.spyOn(AlwaysCleanSpamScanProvider.prototype, "scoreMessage").mockResolvedValue({
                score: 0,
                verdict: SpamVerdict.SUSPECT,
                symbols: ["SCAN_ENGINE_UNAVAILABLE"],
            });

            await ctx.deliver(mail("friend@ok.example", { dkim: "ok.example" }), { envelopeFrom: "friend@ok.example" });
            await ctx.deliver(mail("stranger@other.example", { dkim: "other.example" }), { envelopeFrom: "stranger@other.example" });

            expect((await ctx.messagesIn(FolderType.INBOX)).map((m) => m.from.address)).toEqual(["friend@ok.example"]);
            expect(await ctx.messagesIn(FolderType.JUNK)).toHaveLength(1);
        });
    });

    describe("An address on both lists (edited directly - the write paths never allow it)", () => {
        it("is safe when the message is authenticated, and blocked when it is not.", async () => {
            await ctx.setMailbox({ safeSenders: ["both@x.example"], blockedSenders: ["both@x.example"] });

            await ctx.deliver(mail("both@x.example", { dkim: "x.example", spam: true }), { envelopeFrom: "both@x.example" });
            expect(await ctx.messagesIn(FolderType.INBOX)).toHaveLength(1);
            expect(await ctx.messagesIn(FolderType.JUNK)).toHaveLength(0);

            await ctx.deliver(mail("both@x.example"), { envelopeFrom: "both@x.example" });
            expect(await ctx.messagesIn(FolderType.JUNK)).toHaveLength(1);
        });

        it("is delivered to the Inbox when authenticated and the spam filter found nothing wrong, though also blocked.", async () => {
            await ctx.setMailbox({ safeSenders: ["both@x.example"], blockedSenders: ["both@x.example"] });

            await ctx.deliver(mail("both@x.example", { dkim: "x.example" }), { envelopeFrom: "both@x.example" });

            expect(await ctx.messagesIn(FolderType.INBOX)).toHaveLength(1);
        });
    });

    describe("Mail filter rules: fromEquals and fromDomainEquals", () => {
        it("fromEquals matches the exact address and not a longer one that ends in it (the fromContains substring bug).", async () => {
            await ctx.setMailbox();
            const folder = await ctx.saveFolder("Ann");
            await ctx.saveRule({ name: "Ann", conditions: { fromEquals: ["ann@x.example"] }, actions: [{ type: MailFilterActionType.MOVE_TO_FOLDER, folderUid: folder.uid }] });

            await ctx.deliver(mail("Ann <ann@x.example>"), { envelopeFrom: "ann@x.example" });
            await ctx.deliver(mail("joann@x.example"), { envelopeFrom: "joann@x.example" });

            expect((await ctx.messagesInFolder(folder.uid)).map((m) => m.from.address)).toEqual(["ann@x.example"]);
            expect((await ctx.messagesIn(FolderType.INBOX)).map((m) => m.from.address)).toEqual(["joann@x.example"]);
        });

        it("fromEquals also matches the envelope sender when the From header differs.", async () => {
            await ctx.setMailbox();
            const folder = await ctx.saveFolder("List");
            await ctx.saveRule({ name: "List", conditions: { fromEquals: ["bounce@list.example"] }, actions: [{ type: MailFilterActionType.MOVE_TO_FOLDER, folderUid: folder.uid }] });

            await ctx.deliver(mail("someone@else.example"), { envelopeFrom: "Bounce@List.Example" });

            expect(await ctx.messagesInFolder(folder.uid)).toHaveLength(1);
        });

        it("fromDomainEquals matches the exact domain of either sender, and not a subdomain.", async () => {
            await ctx.setMailbox();
            const folder = await ctx.saveFolder("Corp");
            await ctx.saveRule({ name: "Corp", conditions: { fromDomainEquals: ["corp.example"] }, actions: [{ type: MailFilterActionType.MOVE_TO_FOLDER, folderUid: folder.uid }] });

            await ctx.deliver(mail("a@corp.example"), { envelopeFrom: "a@corp.example" });
            await ctx.deliver(mail("someone@else.example"), { envelopeFrom: "bounce@corp.example" });
            await ctx.deliver(mail("b@mail.corp.example"), { envelopeFrom: "b@mail.corp.example" });

            expect(await ctx.messagesInFolder(folder.uid)).toHaveLength(2);
            expect(await ctx.messagesIn(FolderType.INBOX)).toHaveLength(1);
        });
    });
}
