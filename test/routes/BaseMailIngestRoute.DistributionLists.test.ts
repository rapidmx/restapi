///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for BaseMailIngestRoute's distribution-list expansion/relay/unsubscribe branches
// that are impractical to reach via a real HTTP+DB integration test: a deep (but bounded) nested-list
// chain exceeding `mail:distribution_lists:max_depth`, a nested list's own `restrictSenders` gate, a
// list containing its own address as a member, deduping an external address reached via two different
// nested lists, and the three best-effort try/catch branches (persisting an unsubscribe removal,
// sending its confirmation, relaying to an external member) failing. Every repo/transport dependency is
// a plain mock object, following the exact DI-bypass pattern already established in
// `BaseMailIngestRoute.test.ts` (`objectFactory.newInstance(..., { initialize: false })` plus manual
// field assignment) - see that file's own header comment for why this is preferable to a bare `new`.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { BaseMailIngestRoute } from "../../src/routes/BaseMailIngestRoute.js";

/** Copies constructor args onto the instance, matching real `IngestQueueEntryMongo`/`SQL`'s own
 * merge-from-`other` constructor convention closely enough for `ingestQueueRepo.create()` call
 * assertions below to inspect the fields `deliver()` actually passed. */
class StubEntity {
    constructor(props: any) {
        Object.assign(this, props);
    }
}

class TestMailIngestRoute extends BaseMailIngestRoute<any, any> {
    protected mailboxClass: any = StubEntity;
    protected ingestQueueClass: any = StubEntity;
    protected distributionListClass: any = StubEntity;
    protected transportRuleClass: any = StubEntity;
}

function makeRes(): any {
    return {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
    };
}

function makeReq(from: string, to: string, raw: string): any {
    return {
        headers: { authorization: "Bearer s3cr3t", "x-envelope-from": from, "x-envelope-to": to },
        rawBody: Buffer.from(raw),
        query: {},
    };
}

/** A mailbox/distribution-list repo double keyed by `primarySmtpAddress` only (no alias matching
 * needed by these tests) - `find()` mirrors the real repos' "primary, then alias" two-call shape used
 * by `findMailboxByAddress()`/`findDistributionListByAddress()`, always returning `[]` for the second
 * (alias) call since none of these fixtures use aliases. */
function makeAddressRepo(byAddress: Record<string, any>): any {
    return {
        find: vi.fn(async (query: any) => {
            // Addresses are queried as `ModelUtils.literal()` values.
            const match = query?.primarySmtpAddress && byAddress[query.primarySmtpAddress.value];
            return match ? [match] : [];
        }),
        update: vi.fn(async (obj: any, existing: any) => ({ ...existing, ...obj })),
    };
}

async function makeRoute(overrides: {
    mailboxes?: Record<string, any>;
    lists?: Record<string, any>;
    maxListDepth?: number;
}): Promise<{ route: TestMailIngestRoute; logger: any; mailTransport: any; ingestQueueRepo: any }> {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());
    const route = objectFactory.newInstance<TestMailIngestRoute>(TestMailIngestRoute, { initialize: false });
    const logger = { warn: vi.fn() };
    const ingestQueueRepo = { create: vi.fn() };
    const mailTransport = { send: vi.fn().mockResolvedValue({ accepted: ["x"], rejected: [] }) };

    (route as any).ingestSecret = "s3cr3t";
    (route as any).trustedAuthservId = "mx.example.com";
    (route as any).logger = logger;
    (route as any).blobStore = { put: vi.fn() };
    (route as any).mailTransport = mailTransport;
    (route as any).mailboxRepo = makeAddressRepo(overrides.mailboxes ?? {});
    (route as any).distributionListRepo = makeAddressRepo(overrides.lists ?? {});
    (route as any).transportRuleRepo = { find: vi.fn().mockResolvedValue([]) };
    (route as any).ingestQueueRepo = ingestQueueRepo;
    if (overrides.maxListDepth !== undefined) {
        (route as any).maxListDepth = overrides.maxListDepth;
    }

    return { route, logger, mailTransport, ingestQueueRepo };
}

function mailbox(uid: string, address: string): any {
    return { uid, primarySmtpAddress: address, aliasAddresses: [] };
}

function list(uid: string, address: string, memberAddresses: string[], extra?: any): any {
    return { uid, primarySmtpAddress: address, aliasAddresses: [], name: uid, memberAddresses, version: 0, ...extra };
}

describe("BaseMailIngestRoute Tests (distribution list expansion/relay/unsubscribe branches)", () => {
    it("Stops expanding and logs a warning once the nested-list chain exceeds mail:distribution_lists:max_depth.", async () => {
        const list3 = list("list3", "list3@example.com", ["deepmailbox@example.com"]);
        const list2 = list("list2", "list2@example.com", ["list3@example.com"]);
        const list1 = list("list1", "list1@example.com", ["list2@example.com"]);
        const list0 = list("list0", "list0@example.com", ["list1@example.com"]);
        const { route, logger, ingestQueueRepo } = await makeRoute({
            mailboxes: { "deepmailbox@example.com": mailbox("deep-uid", "deepmailbox@example.com") },
            lists: {
                "list0@example.com": list0,
                "list1@example.com": list1,
                "list2@example.com": list2,
                "list3@example.com": list3,
            },
            maxListDepth: 2,
        });
        const res = makeRes();

        await route.deliver(makeReq("sender@example.com", "list0@example.com", "From: sender@example.com\r\n\r\nHi\r\n"), res);

        expect(ingestQueueRepo.create).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("exceeded max depth"));
    });

    it("A nested list's own restrictSenders drops its own expansion while a sibling real member still gets delivered.", async () => {
        const restricted = list("restricted", "restricted@example.com", ["member-only@example.com"], {
            restrictSenders: true,
        });
        const real = mailbox("real-uid", "real@example.com");
        const top = list("top", "top@example.com", ["restricted@example.com", "real@example.com"]);
        const { route, logger, ingestQueueRepo } = await makeRoute({
            mailboxes: { "real@example.com": real },
            lists: { "top@example.com": top, "restricted@example.com": restricted },
        });
        const res = makeRes();

        await route.deliver(makeReq("outsider@example.com", "top@example.com", "From: outsider@example.com\r\n\r\nHi\r\n"), res);

        expect(ingestQueueRepo.create).toHaveBeenCalledTimes(1);
        expect(ingestQueueRepo.create.mock.calls[0][0].mailboxUid).toBe("real-uid");
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("restricted list 'restricted@example.com'"));
    });

    it("Skips a list that lists its own address as one of its own members, without hanging or double-delivering.", async () => {
        const real = mailbox("real-uid", "real@example.com");
        const selfReferential = list("self", "self@example.com", ["self@example.com", "real@example.com"]);
        const { route, ingestQueueRepo } = await makeRoute({
            mailboxes: { "real@example.com": real },
            lists: { "self@example.com": selfReferential },
        });
        const res = makeRes();

        await route.deliver(makeReq("sender@example.com", "self@example.com", "From: sender@example.com\r\n\r\nHi\r\n"), res);

        expect(ingestQueueRepo.create).toHaveBeenCalledTimes(1);
    });

    it("Dedupes an external address reached via two different nested lists into a single relay send.", async () => {
        const nestedB = list("nestedB", "nestedb@example.com", ["ext@outside.com"]);
        const nestedC = list("nestedC", "nestedc@example.com", ["ext@outside.com"]);
        const top = list("top", "top@example.com", ["nestedb@example.com", "nestedc@example.com"]);
        const { route, mailTransport } = await makeRoute({
            lists: { "top@example.com": top, "nestedb@example.com": nestedB, "nestedc@example.com": nestedC },
        });
        const res = makeRes();

        await route.deliver(makeReq("sender@example.com", "top@example.com", "From: sender@example.com\r\n\r\nHi\r\n"), res);

        expect(mailTransport.send).toHaveBeenCalledTimes(1);
        expect(mailTransport.send.mock.calls[0][0].envelopeTo).toEqual(["ext@outside.com"]);
    });

    it("Reports queued:false, staging nothing, for a distribution list with no members at all.", async () => {
        const empty = list("empty", "empty@example.com", []);
        const { route, ingestQueueRepo } = await makeRoute({ lists: { "empty@example.com": empty } });
        const res = makeRes();

        await route.deliver(makeReq("sender@example.com", "empty@example.com", "From: sender@example.com\r\n\r\nHi\r\n"), res);

        expect(ingestQueueRepo.create).not.toHaveBeenCalled();
        expect(res.json).toHaveBeenCalledWith({ results: [{ rcpt: "empty@example.com", queued: false }] });
    });

    it("Logs a warning and does not attempt the confirmation send when persisting an unsubscribe removal fails.", async () => {
        const member = mailbox("member-uid", "member@example.com");
        const target = list("target", "target@example.com", ["member@example.com"]);
        const { route, logger, mailTransport } = await makeRoute({
            mailboxes: { "member@example.com": member },
            lists: { "target@example.com": target },
        });
        (route as any).distributionListRepo.update = vi.fn().mockRejectedValue(new Error("simulated DB failure"));
        const res = makeRes();

        await route.deliver(
            makeReq(
                "member@example.com",
                "target@example.com",
                "Authentication-Results: mx.example.com; dkim=pass header.d=example.com\r\nFrom: member@example.com\r\nSubject: unsubscribe\r\n\r\nBye\r\n",
            ),
            res,
        );

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("failed to remove unsubscribing member"));
        expect(mailTransport.send).not.toHaveBeenCalled();
    });

    it("Logs a warning (without propagating) when sending the unsubscribe confirmation email fails.", async () => {
        const member = mailbox("member-uid", "member@example.com");
        const target = list("target", "target@example.com", ["member@example.com"]);
        const { route, logger, mailTransport } = await makeRoute({
            mailboxes: { "member@example.com": member },
            lists: { "target@example.com": target },
        });
        mailTransport.send.mockRejectedValueOnce(new Error("simulated transport failure"));
        const res = makeRes();

        await route.deliver(
            makeReq(
                "member@example.com",
                "target@example.com",
                "Authentication-Results: mx.example.com; dkim=pass header.d=example.com\r\nFrom: member@example.com\r\nSubject: unsubscribe\r\n\r\nBye\r\n",
            ),
            res,
        );

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("failed to send unsubscribe confirmation"));
    });

    it("Logs a warning (without failing the whole delivery) when relaying to an external member fails.", async () => {
        const target = list("target", "target@example.com", ["ext@outside.com"]);
        const { route, logger, mailTransport } = await makeRoute({ lists: { "target@example.com": target } });
        mailTransport.send.mockRejectedValueOnce(new Error("simulated transport failure"));
        const res = makeRes();

        await route.deliver(makeReq("sender@example.com", "target@example.com", "From: sender@example.com\r\n\r\nHi\r\n"), res);

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("failed to relay distribution list message"));
        expect(res.status).toHaveBeenCalledWith(202);
    });
});
