///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.sql.js";
import { request } from "@rapidrest/service-core/test";
import { Server, ObjectFactory, ConnectionManager, isSqlDataSource } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import { EscrowScopeSQL } from "../../../src/models/sql/EscrowScopeSQL.js";
import { MatterSQL } from "../../../src/models/sql/MatterSQL.js";
import { registerTestDoubles, NoopSearchProvider } from "../../testDoubles.js";

describe("Route:MatterSearchSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/matter-search";
    let escrowScopeRepo: Repository<EscrowScopeSQL>;
    let matterRepo: Repository<MatterSQL>;

    const holder: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const holderToken = JWTUtils.createTokenSync(config.get("auth"), holder);
    const otherUser: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const otherUserToken = JWTUtils.createTokenSync(config.get("auth"), otherUser);

    const validPublicKey = { publicKey: "base64cert", type: "x509", fingerprint: "abc123", notBefore: 1000, notAfter: 2000 };

    const createEscrowScope = async (data?: Partial<EscrowScopeSQL>): Promise<EscrowScopeSQL> =>
        await escrowScopeRepo.save(
            new EscrowScopeSQL({ name: "legal", publicKey: validPublicKey, holderUserUids: [holder.uid], requiredHolders: 1, ...data }),
        );

    const createMatter = async (escrowScopeId: string, data?: Partial<MatterSQL>): Promise<MatterSQL> =>
        await matterRepo.save(
            new MatterSQL({
                name: "Investigation A",
                escrowScopeId,
                custodianMailboxUids: [uuid.v4(), uuid.v4()],
                dateRangeStart: new Date("2026-01-01"),
                dateRangeEnd: new Date("2026-06-01"),
                ...data,
            }),
        );

    beforeAll(async () => {
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("sql");
        if (isSqlDataSource(conn)) {
            escrowScopeRepo = conn.getRepository(EscrowScopeSQL);
            matterRepo = conn.getRepository(MatterSQL);
        } else {
            throw new Error("Could not find sql connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await matterRepo.clear();
        await escrowScopeRepo.clear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("Rejects a request with no matterId (400).", async () => {
        const result = await request(server.getApplication())
            .get(`${baseUrl}?q=hello`)
            .set("Authorization", "jwt " + holderToken);
        expect(result.status).toBe(400);
    });

    it("Rejects a request with neither q nor a structured filter (400).", async () => {
        const scope = await createEscrowScope();
        const matter = await createMatter(scope.uid);
        const result = await request(server.getApplication())
            .get(`${baseUrl}?matterId=${matter.uid}`)
            .set("Authorization", "jwt " + holderToken);
        expect(result.status).toBe(400);
    });

    it("Returns 404 for a nonexistent matter.", async () => {
        const result = await request(server.getApplication())
            .get(`${baseUrl}?matterId=${uuid.v4()}&q=hello`)
            .set("Authorization", "jwt " + holderToken);
        expect(result.status).toBe(404);
    });

    it("Rejects an unauthenticated caller.", async () => {
        const scope = await createEscrowScope();
        const matter = await createMatter(scope.uid);
        const result = await request(server.getApplication()).get(`${baseUrl}?matterId=${matter.uid}&q=hello`);
        expect(result.status).toBe(403);
    });

    it("Rejects a caller who isn't a holder of the matter's escrow scope (403).", async () => {
        const scope = await createEscrowScope();
        const matter = await createMatter(scope.uid);
        const result = await request(server.getApplication())
            .get(`${baseUrl}?matterId=${matter.uid}&q=hello`)
            .set("Authorization", "jwt " + otherUserToken);
        expect(result.status).toBe(403);
    });

    it("A holder searches across every custodian mailbox, returning one result page per mailbox.", async () => {
        const scope = await createEscrowScope();
        const matter = await createMatter(scope.uid);

        const searchProvider = objectFactory.getInstance<NoopSearchProvider>("SearchProvider")!;
        await searchProvider.index({
            entityType: "message",
            entityUid: uuid.v4(),
            mailboxUid: matter.custodianMailboxUids[0],
            subject: "hello world",
        });

        const result = await request(server.getApplication())
            .get(`${baseUrl}?matterId=${matter.uid}&q=hello`)
            .set("Authorization", "jwt " + holderToken);

        expect(result.status).toBe(200);
        expect(Object.keys(result.body).sort()).toEqual([...matter.custodianMailboxUids].sort());
        expect(result.body[matter.custodianMailboxUids[0]].results.length).toBe(1);
        expect(result.body[matter.custodianMailboxUids[1]].results.length).toBe(0);
    });

    it("Clamps a caller-supplied before/after to the matter's own date range.", async () => {
        const scope = await createEscrowScope();
        const matter = await createMatter(scope.uid, { dateRangeStart: new Date("2026-02-01"), dateRangeEnd: new Date("2026-04-01") });

        const searchProvider = objectFactory.getInstance<NoopSearchProvider>("SearchProvider")!;
        const searchSpy = vi.spyOn(searchProvider, "search");

        const result = await request(server.getApplication())
            .get(`${baseUrl}?matterId=${matter.uid}&q=hello&before=2026-12-31T00:00:00.000Z&after=2020-01-01T00:00:00.000Z`)
            .set("Authorization", "jwt " + holderToken);

        expect(result.status).toBe(200);
        expect(searchSpy).toHaveBeenCalled();
        for (const call of searchSpy.mock.calls) {
            expect(call[0].before!.getTime()).toBe(matter.dateRangeEnd.getTime());
            expect(call[0].after!.getTime()).toBe(matter.dateRangeStart.getTime());
        }
    });

    it("Defaults to the matter's full date range when the caller supplies no before/after at all.", async () => {
        const scope = await createEscrowScope();
        const matter = await createMatter(scope.uid);

        const searchProvider = objectFactory.getInstance<NoopSearchProvider>("SearchProvider")!;
        const searchSpy = vi.spyOn(searchProvider, "search");

        const result = await request(server.getApplication())
            .get(`${baseUrl}?matterId=${matter.uid}&q=hello`)
            .set("Authorization", "jwt " + holderToken);

        expect(result.status).toBe(200);
        for (const call of searchSpy.mock.calls) {
            expect(call[0].before!.getTime()).toBe(matter.dateRangeEnd.getTime());
            expect(call[0].after!.getTime()).toBe(matter.dateRangeStart.getTime());
        }
    });

    it("A narrower caller-supplied before/after (already inside the matter's range) is honored as-is.", async () => {
        const scope = await createEscrowScope();
        const matter = await createMatter(scope.uid, { dateRangeStart: new Date("2026-01-01"), dateRangeEnd: new Date("2026-12-31") });

        const searchProvider = objectFactory.getInstance<NoopSearchProvider>("SearchProvider")!;
        const searchSpy = vi.spyOn(searchProvider, "search");
        const narrowBefore = new Date("2026-03-01T00:00:00.000Z");
        const narrowAfter = new Date("2026-02-01T00:00:00.000Z");

        await request(server.getApplication())
            .get(`${baseUrl}?matterId=${matter.uid}&q=hello&before=${narrowBefore.toISOString()}&after=${narrowAfter.toISOString()}`)
            .set("Authorization", "jwt " + holderToken);

        for (const call of searchSpy.mock.calls) {
            expect(call[0].before!.getTime()).toBe(narrowBefore.getTime());
            expect(call[0].after!.getTime()).toBe(narrowAfter.getTime());
        }
    });
});
