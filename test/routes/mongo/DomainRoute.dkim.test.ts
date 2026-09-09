///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Covers BaseDomainRoute's DKIM auto-generation wiring specifically - a separate file/server from
// test/routes/mongo/DomainRoute.test.ts (which deliberately registers no DkimKeyProvider at all, so its
// own create()/dns-setup() behavior stays exactly as it was before this feature existed) so that suite's
// "reports dkim as not configured" case keeps proving the no-provider-registered default is unaffected.
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import config from "../../config.js";
import { request } from "@rapidrest/service-core/test";
import { MongoConnection, MongoRepository, Server, ObjectFactory, ConnectionManager } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { DomainMongo } from "../../../src/models/mongo/DomainMongo.js";
import { FsDkimKeyProvider } from "../../../src/dkim/FsDkimKeyProvider.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        port: 9999,
        dbName: "rrst-test",
    },
});

describe("Route:DomainMongo DKIM auto-generation Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const baseUrl = "/mongo/domains";
    let repo: MongoRepository<DomainMongo>;
    let tmpDir: string;

    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const adminToken = JWTUtils.createTokenSync(config.get("auth"), admin);

    const createDomain = async function (data?: any): Promise<DomainMongo> {
        const name: string = data?.name ?? `${uuid.v4()}.example.com`;
        const obj: DomainMongo = new DomainMongo({
            uid: name,
            name,
            enabled: true,
            verified: true,
            verificationToken: uuid.v4(),
            ...data,
        });
        return await repo.save(obj);
    };

    beforeAll(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "domainroute-dkim-test-"));
        await mongod.start();
        // `ObjectFactory.register()` is first-registration-wins (a no-op if the name is already taken) -
        // must come BEFORE `registerTestDoubles()`, which would otherwise win the race and register
        // `NullDkimKeyProvider` under this same name first.
        objectFactory.register(FsDkimKeyProvider, "DkimKeyProvider");
        registerTestDoubles(objectFactory);
        await server.start();

        const dkimProvider = objectFactory.getInstance<FsDkimKeyProvider>("DkimKeyProvider")!;
        (dkimProvider as any).keyDir = tmpDir;
        (dkimProvider as any).selector = "mail";

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("mongo");
        if (conn instanceof MongoConnection) {
            repo = conn.getMongoRepository("DomainMongo");
        } else {
            throw new Error("Could not find mongo connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await mongod.stop();
        await objectFactory.destroy();
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    beforeEach(async () => {
        try {
            await repo.clear();
        } catch (err: any) {
            if (err.message !== "ns not found") {
                throw err;
            }
        }
    });

    it("Auto-generates and persists a DKIM key pair for a newly created domain.", async () => {
        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({ name: "auto-dkim.com" });

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body.dkimSelector).toBe("mail");
        expect(typeof result.body.dkimPublicKey).toBe("string");
        expect(result.body.dkimPublicKey.length).toBeGreaterThan(0);

        const keyFile: string = path.join(tmpDir, "auto-dkim.com.mail.key");
        await expect(fs.access(keyFile)).resolves.toBeUndefined();
    });

    it("Respects a caller-supplied dkimSelector/dkimPublicKey instead of overwriting it.", async () => {
        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({ name: "manual-dkim.com", dkimSelector: "manual", dkimPublicKey: "caller-supplied-key" });

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body.dkimSelector).toBe("manual");
        expect(result.body.dkimPublicKey).toBe("caller-supplied-key");

        // No key file should have been generated for this domain - the provider was never invoked.
        const keyFile: string = path.join(tmpDir, "manual-dkim.com.manual.key");
        await expect(fs.access(keyFile)).rejects.toThrow();
    });

    it("Backfills a DKIM key pair the first time dns-setup() is called on a pre-existing domain missing one.", async () => {
        const domain = await createDomain({ name: "backfill-me.com" });
        expect(domain.dkimSelector).toBeUndefined();

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${domain.uid}/dns-setup`)
            .set("Authorization", "jwt " + adminToken);

        expect(result.status).toBe(200);
        const dkim = result.body.find((c: any) => c.type === "dkim");
        expect(dkim.configured).toBe(true);

        const updated = await repo.findOne({ uid: domain.uid } as any);
        expect(updated?.dkimSelector).toBe("mail");
        expect(typeof updated?.dkimPublicKey).toBe("string");
    });

    it("Does not regenerate a key pair for a domain that already has one.", async () => {
        const created = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({ name: "stable-dkim.com" });
        const firstPublicKey: string = created.body.dkimPublicKey;

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${created.body.uid}/dns-setup`)
            .set("Authorization", "jwt " + adminToken);

        expect(result.status).toBe(200);
        const refreshed = await repo.findOne({ uid: created.body.uid } as any);
        expect(refreshed?.dkimPublicKey).toBe(firstPublicKey);
    });
});
