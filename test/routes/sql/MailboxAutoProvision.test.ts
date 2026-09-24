///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// SQL counterpart of test/routes/mongo/MailboxAutoProvision.test.ts — see that file's header comment
// for why this lives in its own file (needs `mail:auto_provision:enabled` turned on and verified
// `Domain` rows seeded, isolated from MailboxRoute.test.ts's own unrestricted-domain assumptions via
// per-file module isolation).
import config from "../../config.sql.js";

config.set("mail:auto_provision:enabled", true);
config.set("mail:auth_server_url", "http://auth.test");

import { request } from "@rapidrest/service-core/test";
import { AccessControlListSQL, Server, ObjectFactory, ConnectionManager, isSqlDataSource } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import { DomainSQL } from "../../../src/models/sql/DomainSQL.js";
import { FolderSQL } from "../../../src/models/sql/FolderSQL.js";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { MailboxPolicySQL } from "../../../src/models/sql/MailboxPolicySQL.js";
import { MAILBOX_POLICY_UID } from "../../../src/util/MailboxPolicyUtils.js";
import { registerTestDoubles } from "../../testDoubles.js";
import { mailboxSelfServiceCreateSuite } from "../mailboxSelfServiceCreateSuite.js";

describe("Route:MailboxSQL auto-provision/domain Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/mailboxes";
    let repo: Repository<MailboxSQL>;
    let domainRepo: Repository<DomainSQL>;
    let policyRepo: Repository<MailboxPolicySQL>;

    const user: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const userToken = JWTUtils.createTokenSync(config.get("auth"), user);
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const adminToken = JWTUtils.createTokenSync(config.get("auth"), admin);

    let mockFetch: ReturnType<typeof vi.fn>;

    // The framework's own auth reads the `Authorization` header (see MailboxRoute.test.ts's identical
    // `.set("Authorization", ...)` usage); `fetchNameAliases()` additionally forwards the raw `jwt`
    // cookie a real browser session would send, so tests exercising it need both set to the same
    // token. `supertest`'s `.set()` only accepts (field, value) pairs here, not an object literal (that
    // form silently sends no headers at all against this version) — chain two calls instead.
    function withAuth<T extends { set: (field: string, val: string) => T }>(req: T, token: string): T {
        return req.set("Authorization", "jwt " + token).set("Cookie", `jwt=${token}`);
    }

    // What auth-server's `GET /api/aliases` answers with: `Alias` records, each naming itself in `alias`.
    function aliasResponse(values: string[], ok = true, status = 200) {
        return {
            ok,
            status,
            json: vi.fn().mockResolvedValue(
                values.map((alias, i) => ({ uid: `alias-${i}`, version: 0, alias, type: "name", userUid: user.uid, verified: true })),
            ),
        };
    }

    const ALIAS_LIST_URL = "http://auth.test/api/aliases?type=name&userUid=me";

    /** Stubs auth-server answering ONLY the real alias-list request with these name aliases; any other URL - such as the
     * `/api/aliases/me?type=name` this route once asked for, which auth-server answers 404 - fails like the real thing. */
    function mockAliasList(values: string[]) {
        mockFetch.mockImplementation(async (url: string) =>
            url === ALIAS_LIST_URL ? aliasResponse(values) : { ok: false, status: 404, json: vi.fn().mockResolvedValue({ code: "api-010" }) },
        );
    }

    beforeAll(async () => {
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("sql");
        if (isSqlDataSource(conn)) {
            repo = conn.getRepository(MailboxSQL);
            domainRepo = conn.getRepository(DomainSQL);
            policyRepo = conn.getRepository(MailboxPolicySQL);
        } else {
            throw new Error("Could not find sql connection");
        }

        // `save()` upserts on the primary key (`uid`), so re-running against the shared on-disk SQLite
        // file used by every SQL test just refreshes these rows rather than conflicting with a prior
        // run's (see restapi's own testing-conventions note).
        for (const name of ["example.com", "example.org"]) {
            await domainRepo.save(
                new DomainSQL({ name, enabled: true, verified: true, verificationToken: uuid.v4(), uid: name } as any),
            );
        }
    });

    afterAll(async () => {
        // These seeded `Domain` rows live in the shared on-disk SQLite file every SQL test file uses -
        // clean them up so they can't leak into an unrelated later test file's own unrestricted-domain
        // assumptions within the same `vitest run` process (see DistributionListDomains.test.ts's
        // identical rationale).
        await domainRepo.delete({ uid: "example.com" });
        await domainRepo.delete({ uid: "example.org" });
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await repo.clear();
        // Clearing mailboxes alone leaves their folders and ACLs behind, and creating a mailbox at an address with a
        // deleted mailbox's leftovers is refused (409) - these tests reuse fixed addresses.
        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        await (connMgr?.connections.get("sql") as any).getRepository(FolderSQL).clear();
        await (connMgr?.connections.get("acl") as any)
            .getRepository(AccessControlListSQL)
            .createQueryBuilder()
            .delete()
            .where("uid LIKE :pattern", { pattern: "%@%" })
            .execute();
        // The mailbox policy is seeded from config on first use and SQL test files share a database, so a row
        // another suite seeded (with auto-provisioning off) must not leak into this one.
        await policyRepo.clear();
        mockFetch = vi.fn();
        vi.stubGlobal("fetch", mockFetch);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("Returns the caller's existing mailbox (status 'existing') without contacting auth-server, when they already have one.", async () => {
        const obj = new MailboxSQL({
            ownerUserUid: user.uid,
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "Already Provisioned",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
        });
        await repo.save(obj);

        const result = await withAuth(request(server.getApplication()).post(`${baseUrl}/auto-provision`), userToken);

        expect(result.status).toBe(200);
        expect(result.body.status).toBe("existing");
        expect(result.body.mailbox.uid).toBe(obj.uid);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("Returns 503, creating nothing, when the mailbox policy can't be read - never falling back to config's 'enabled'.", async () => {
        const newInstance = objectFactory.newInstance.bind(objectFactory);
        const spy = vi.spyOn(objectFactory, "newInstance").mockImplementation((...args: any[]) =>
            args[1]?.name === "MailboxPolicySQL" ? Promise.reject(new Error("datastore offline")) : (newInstance as any)(...args),
        );
        try {
            const result = await withAuth(request(server.getApplication()).post(`${baseUrl}/auto-provision`), userToken);
            expect(result.status).toBe(503);
        } finally {
            spy.mockRestore();
        }
        expect(mockFetch).not.toHaveBeenCalled();
        expect(await repo.count()).toBe(0);
    });

    it("Returns 404 when auth-server reports no registered name aliases for the caller.", async () => {
        mockAliasList([]);

        const result = await withAuth(request(server.getApplication()).post(`${baseUrl}/auto-provision`), userToken);

        expect(result.status).toBe(404);
    });

    it("Asks auth-server for the caller's name aliases at GET /api/aliases?type=name&userUid=me, with their jwt cookie - not /api/aliases/me.", async () => {
        mockAliasList(["jsteinmetz"]);

        const result = await withAuth(request(server.getApplication()).post(`${baseUrl}/auto-provision`), userToken);

        expect(result.status).toBe(200);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url, init] = mockFetch.mock.calls[0];
        expect(url).toBe("http://auth.test/api/aliases?type=name&userUid=me");
        expect(new URL(url).pathname).toBe("/api/aliases");
        expect(init.headers).toEqual({ Cookie: `jwt=${userToken}` });
    });

    it("Reads the alias out of each Alias record's 'alias' field.", async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
            json: vi.fn().mockResolvedValue([
                { uid: "1", version: 0, alias: "jsteinmetz", type: "name", userUid: user.uid, verified: true },
            ]),
        });

        const result = await withAuth(request(server.getApplication()).post(`${baseUrl}/auto-provision`), userToken);

        expect(result.status).toBe(200);
        expect(result.body.options).toEqual([
            { alias: "jsteinmetz", domain: "example.com", primarySmtpAddress: "jsteinmetz@example.com" },
            { alias: "jsteinmetz", domain: "example.org", primarySmtpAddress: "jsteinmetz@example.org" },
        ]);
    });

    it("Returns 502 when auth-server answers the alias list with 404 - a missing endpoint is not 'no username'.", async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 404, json: vi.fn().mockResolvedValue({ code: "api-010" }) });

        const result = await withAuth(request(server.getApplication()).post(`${baseUrl}/auto-provision`), userToken);

        expect(result.status).toBe(502);
    });

    const repoCount = async () => await repo.count();

    describe("only the caller's own aliases count, whatever auth-server lists", () => {
        /** A listing that mixes in aliases of other users (and of no user), as an unscoped answer to an administrator would. */
        const mixedList = (ownUid: string) => ({
            ok: true,
            status: 200,
            json: vi.fn().mockResolvedValue([
                { uid: "1", alias: "someone-else", type: "name", userUid: uuid.v4(), verified: true },
                { uid: "2", alias: "mine", type: "name", userUid: ownUid, verified: true },
                { uid: "3", alias: "no-owner", type: "name", verified: true },
                { uid: "4", alias: "mine-too", type: "name", userUid: ownUid.toUpperCase(), verified: true },
                { uid: "5", alias: "numeric-owner", type: "name", userUid: 42, verified: true },
            ]),
        });

        it("offers only the caller's own aliases when the answer also holds another user's.", async () => {
            mockFetch.mockResolvedValue(mixedList(user.uid));

            const result = await withAuth(request(server.getApplication()).post(`${baseUrl}/auto-provision`), userToken);

            expect(result.status).toBe(200);
            expect(result.body.options.map((o: any) => o.alias)).toEqual(["mine", "mine", "mine-too", "mine-too"]);
        });

        it("offers an administrator only their own aliases, not everyone's.", async () => {
            mockFetch.mockResolvedValue(mixedList(admin.uid));

            const result = await withAuth(request(server.getApplication()).post(`${baseUrl}/auto-provision`), adminToken);

            expect(result.status).toBe(200);
            expect(result.body.options.map((o: any) => o.alias)).toEqual(["mine", "mine", "mine-too", "mine-too"]);
        });

        it("refuses (400) an alias of another user requested through body.alias, creating nothing.", async () => {
            for (const token of [userToken, adminToken]) {
                mockFetch.mockResolvedValue(mixedList(token === userToken ? user.uid : admin.uid));

                const result = await withAuth(request(server.getApplication()).post(`${baseUrl}/auto-provision`), token).send({
                    alias: "someone-else",
                    domain: "example.com",
                });

                expect(result.status).toBe(400);
            }
            expect(await repoCount()).toBe(0);
        });

        it("answers 404 - no username - when every alias listed belongs to someone else.", async () => {
            mockFetch.mockResolvedValue(mixedList(uuid.v4()));

            const result = await withAuth(request(server.getApplication()).post(`${baseUrl}/auto-provision`), userToken);

            expect(result.status).toBe(404);
        });

        it("refuses a plain POST / at another user's username, as at any name that is not the caller's own.", async () => {
            mockFetch.mockResolvedValue(mixedList(user.uid));

            const result = await withAuth(request(server.getApplication()).post(baseUrl), userToken).send({
                primarySmtpAddress: "someone-else@example.com",
                displayName: "Not mine",
                timezone: "UTC",
            });

            expect(result.status).toBe(403);
            expect(await repoCount()).toBe(0);
        });
    });

    it("With no alias/domain chosen, returns needs_selection with the full alias x domain cross product.", async () => {
        mockAliasList(["jsteinmetz", "jp"]);

        const result = await withAuth(request(server.getApplication()).post(`${baseUrl}/auto-provision`), userToken);

        expect(result.status).toBe(200);
        expect(result.body.status).toBe("needs_selection");
        expect(result.body.options).toEqual(
            expect.arrayContaining([
                { alias: "jsteinmetz", domain: "example.com", primarySmtpAddress: "jsteinmetz@example.com" },
                { alias: "jsteinmetz", domain: "example.org", primarySmtpAddress: "jsteinmetz@example.org" },
                { alias: "jp", domain: "example.com", primarySmtpAddress: "jp@example.com" },
                { alias: "jp", domain: "example.org", primarySmtpAddress: "jp@example.org" },
            ]),
        );
        expect(result.body.options).toHaveLength(4);
    });

    it("Rejects a chosen alias that isn't one of the caller's real auth-server aliases.", async () => {
        mockAliasList(["jsteinmetz"]);

        const result = await withAuth(request(server.getApplication()).post(`${baseUrl}/auto-provision`), userToken).send({
            alias: "not-mine",
            domain: "example.com",
        });

        expect(result.status).toBe(400);
    });

    it("Rejects a chosen domain that isn't in the configured domain list.", async () => {
        mockAliasList(["jsteinmetz"]);

        const result = await withAuth(request(server.getApplication()).post(`${baseUrl}/auto-provision`), userToken).send({
            alias: "jsteinmetz",
            domain: "not-configured.com",
        });

        expect(result.status).toBe(400);
    });

    it("Gives the mailbox the time zone the caller's device reported, and UTC when there is none or it isn't one.", async () => {
        mockAliasList(["jsteinmetz"]);
        const created = await withAuth(request(server.getApplication()).post(`${baseUrl}/auto-provision`), userToken).send({
            alias: "jsteinmetz",
            domain: "example.org",
            timezone: "America/Los_Angeles",
        });
        expect(created.status).toBe(200);
        expect(created.body.mailbox.timezone).toBe("America/Los_Angeles");
    });

    it("Falls back to UTC for a time zone that isn't one.", async () => {
        mockAliasList(["jsteinmetz"]);
        const created = await withAuth(request(server.getApplication()).post(`${baseUrl}/auto-provision`), userToken).send({
            alias: "jsteinmetz",
            domain: "example.org",
            timezone: "Mars/Olympus",
        });
        expect(created.status).toBe(200);
        expect(created.body.mailbox.timezone).toBe("UTC");
    });

    it("Creates the mailbox (with its well-known folders) for a valid chosen alias/domain, and returns status 'created'.", async () => {
        mockAliasList(["jsteinmetz"]);

        const result = await withAuth(request(server.getApplication()).post(`${baseUrl}/auto-provision`), userToken).send({
            alias: "jsteinmetz",
            domain: "example.org",
        });

        expect(result.status).toBe(200);
        expect(result.body.status).toBe("created");
        expect(result.body.mailbox.primarySmtpAddress).toBe("jsteinmetz@example.org");
        expect(result.body.mailbox.ownerUserUid).toBe(user.uid);

        const folders = await withAuth(
            request(server.getApplication()).get(`/sql/folders?mailboxUid=${result.body.mailbox.uid}`),
            userToken,
        );
        expect(folders.body.map((f: any) => f.type).sort()).toEqual(["archive", "calendar", "contacts", "deleted_items", "drafts", "inbox", "junk", "notes", "outbox", "sent_items", "tasks"]);
    });

    it("Returns 502 when auth-server responds with a non-OK status.", async () => {
        mockFetch.mockResolvedValue(aliasResponse([], false, 500));

        const result = await withAuth(request(server.getApplication()).post(`${baseUrl}/auto-provision`), userToken);

        expect(result.status).toBe(502);
    });

    it("Returns 502 when the call to auth-server itself fails (network error).", async () => {
        mockFetch.mockRejectedValue(new Error("network down"));

        const result = await withAuth(request(server.getApplication()).post(`${baseUrl}/auto-provision`), userToken);

        expect(result.status).toBe(502);
    });

    it("listDomains() returns this server's configured domain list.", async () => {
        const result = await withAuth(request(server.getApplication()).get(`${baseUrl}/domains`), userToken);

        expect(result.status).toBe(200);
        expect(result.body).toEqual(["example.com", "example.org"]);
    });

    it("create() rejects an off-domain address even for a trusted (admin) caller — the domain list applies to everyone.", async () => {
        const result = await withAuth(request(server.getApplication()).post(baseUrl), adminToken).send({
            primarySmtpAddress: `${uuid.v4()}@not-configured.com`,
            aliasAddresses: [],
            displayName: "Admin Off-domain",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
        });

        expect(result.status).toBe(400);
    });

    describe("pure alias domain", () => {
        const seedAlias = async (): Promise<void> => {
            // Each test in this `describe` seeds the same alias domain - clear any prior copy first so a
            // second/third test doesn't collide on `uid`, the same reuse-a-fixed-address convention this
            // file's own header comment already documents for mailboxes.
            await domainRepo.delete({ uid: "plc.gg" });
            await domainRepo.save(new DomainSQL({ name: "plc.gg", enabled: true, verified: true, aliasOf: "example.com" } as any));
        };

        it("create() rejects an alias-domain address in aliasAddresses even for a trusted (admin) caller, though the primary address is on a real verified domain.", async () => {
            await seedAlias();

            const result = await withAuth(request(server.getApplication()).post(baseUrl), adminToken).send({
                primarySmtpAddress: `${uuid.v4()}@example.com`,
                aliasAddresses: ["boss@plc.gg"],
                displayName: "Admin Alias-domain Alias",
                timezone: "UTC",
                quotaBytes: 1_000_000_000,
                usedBytes: 0,
            });

            expect(result.status).toBe(400);
        });

        it("self-service create() refuses an alias-domain address, even one matching the caller's own username, since a pure alias domain has no mailboxes of its own.", async () => {
            await seedAlias();
            mockAliasList(["jsteinmetz"]);

            const result = await withAuth(request(server.getApplication()).post(baseUrl), userToken).send({
                primarySmtpAddress: "jsteinmetz@plc.gg",
                aliasAddresses: [],
                displayName: "Mine On Alias Domain",
                timezone: "UTC",
            });

            expect(result.status).toBe(403);
            expect(await repo.find()).toEqual([]);
        });

        it("self-service PUT refuses adding an alias-domain address to aliasAddresses, even one matching the caller's own username.", async () => {
            await seedAlias();
            mockAliasList(["jsteinmetz"]);
            const created = await withAuth(request(server.getApplication()).post(baseUrl), userToken).send({
                primarySmtpAddress: "jsteinmetz@example.com",
                aliasAddresses: [],
                displayName: "Mine",
                timezone: "UTC",
            });
            expect(created.status).toBe(200);

            const result = await withAuth(request(server.getApplication()).put(`${baseUrl}/${created.body.uid}`), userToken).send({
                uid: created.body.uid,
                version: created.body.version,
                aliasAddresses: ["jsteinmetz@plc.gg"],
            });

            expect(result.status).toBe(400);
        });
    });

    mailboxSelfServiceCreateSuite({
        app: () => server.getApplication(),
        baseUrl,
        userUid: user.uid,
        userToken,
        adminToken,
        withAuth,
        mockAliases: (aliases) => mockAliasList(aliases),
        disableSelfService: async () => {
            await policyRepo.save(new MailboxPolicySQL({ uid: MAILBOX_POLICY_UID, autoProvisionEnabled: false } as any));
        },
        mailboxes: () => repo.find(),
        tokenFor: (subject) => JWTUtils.createTokenSync(config.get("auth"), subject),
    });
});
