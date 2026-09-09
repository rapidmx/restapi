///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.js";
import { request } from "@rapidrest/service-core/test";
import { MongoConnection, MongoRepository, Server, ObjectFactory, ConnectionManager } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { AuditLogEntryMongo } from "../../../src/models/mongo/AuditLogEntryMongo.js";
import { BrandingMongo } from "../../../src/models/mongo/BrandingMongo.js";
import { AuditAction } from "../../../src/models/types.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

describe("Route:BrandingMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const baseUrl = "/mongo/branding";
    let brandingRepo: MongoRepository<BrandingMongo>;
    let auditLogRepo: MongoRepository<AuditLogEntryMongo>;

    const user: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const userToken = JWTUtils.createTokenSync(config.get("auth"), user);
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const adminToken = JWTUtils.createTokenSync(config.get("auth"), admin);

    beforeAll(async () => {
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("mongo");
        if (conn instanceof MongoConnection) {
            brandingRepo = conn.getMongoRepository("BrandingMongo");
            auditLogRepo = conn.getMongoRepository("AuditLogEntryMongo");
        } else {
            throw new Error("Could not find mongo connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await mongod.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        for (const repo of [brandingRepo, auditLogRepo]) {
            try {
                await repo.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
    });

    describe("GET /branding (public)", () => {
        it("Returns all-empty defaults, never a 404, before anything has been configured.", async () => {
            const result = await request(server.getApplication()).get(baseUrl);

            expect(result.status).toBe(200);
            expect(result.body).toEqual({ companyName: "", title: "" });
        });

        it("Returns the configured branding once an admin has set it, with no Authorization header at all.", async () => {
            await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ companyName: "Acme", title: "Acme Mail" });

            const result = await request(server.getApplication()).get(baseUrl);

            expect(result.status).toBe(200);
            expect(result.body).toEqual({ companyName: "Acme", title: "Acme Mail" });
        });

        it("Never exposes internal blob bookkeeping fields.", async () => {
            await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ companyName: "Acme", title: "Acme Mail", logoUrl: "https://cdn.example.com/logo.png" });

            const result = await request(server.getApplication()).get(baseUrl);

            expect(result.body.logoBlobKey).toBeUndefined();
            expect(result.body.logoContentType).toBeUndefined();
        });
    });

    describe("PUT /branding (trusted role only)", () => {
        it("Rejects a non-trusted caller (403).", async () => {
            const result = await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + userToken)
                .send({ companyName: "Acme" });

            expect(result.status).toBe(403);
        });

        it("Rejects an unauthenticated caller (401/403).", async () => {
            const result = await request(server.getApplication()).put(baseUrl).send({ companyName: "Acme" });

            expect(result.status).toBeGreaterThanOrEqual(400);
        });

        it("A trusted caller creates the singleton row on first write.", async () => {
            const result = await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ companyName: "Acme", title: "Acme Mail" });

            expect(result.status).toBe(200);
            expect(result.body).toEqual({ companyName: "Acme", title: "Acme Mail" });

            const rows = await brandingRepo.find({}).toArray();
            expect(rows).toHaveLength(1);
            expect(rows[0].uid).toBe("branding");
        });

        it("Is a genuine partial patch - a later PUT touching only one field leaves the rest alone.", async () => {
            await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ companyName: "Acme", title: "Acme Mail", headerHtml: "<div>Header</div>" });

            const result = await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ title: "Acme Mail v2" });

            expect(result.status).toBe(200);
            expect(result.body.companyName).toBe("Acme");
            expect(result.body.title).toBe("Acme Mail v2");
            expect(result.body.headerHtml).toBe("<div>Header</div>");
        });

        it("Ignores a client-supplied logoBlobKey/logoContentType - never settable directly.", async () => {
            const result = await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ companyName: "Acme", title: "Acme Mail", logoBlobKey: "attacker-key", logoContentType: "image/png" } as any);

            expect(result.status).toBe(200);
            const row = await brandingRepo.findOne({ uid: "branding" } as any);
            expect((row as any)?.logoBlobKey).toBeUndefined();
        });

        it("Records an audit log entry.", async () => {
            await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ companyName: "Acme", title: "Acme Mail" });

            const entries = await auditLogRepo.find({ action: AuditAction.BRANDING_UPDATE }).toArray();
            expect(entries).toHaveLength(1);
        });

        it("Logs rather than throws when deleting the orphaned blob fails.", async () => {
            const png = Buffer.from("PNG-fake-image-bytes-1");
            await request(server.getApplication())
                .post(`${baseUrl}/logo`)
                .set("Authorization", "jwt " + adminToken)
                .set("Content-Type", "image/png")
                .send(png);

            const blobStore: any = objectFactory.getInstance("BlobStore");
            const spy = vi.spyOn(blobStore, "delete").mockRejectedValueOnce(new Error("disk is full"));
            const result = await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ logoUrl: "https://cdn.example.com/logo.png" });

            expect(result.status).toBe(200);
            spy.mockRestore();
        });

        it("Setting logoUrl directly clears and deletes a previously self-hosted logo blob.", async () => {
            const png = Buffer.from("PNG-fake-image-bytes-1");
            await request(server.getApplication())
                .post(`${baseUrl}/logo`)
                .set("Authorization", "jwt " + adminToken)
                .set("Content-Type", "image/png")
                .send(png);

            const result = await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ logoUrl: "https://cdn.example.com/logo.png" });

            expect(result.status).toBe(200);
            expect(result.body.logoUrl).toBe("https://cdn.example.com/logo.png");

            const logoResult = await request(server.getApplication()).get(`${baseUrl}/logo`);
            expect(logoResult.status).toBe(404);
        });
    });

    describe("POST/GET/DELETE /branding/logo", () => {
        const png = Buffer.from("PNG-fake-image-bytes-header");

        it("Rejects an upload from a non-trusted caller (403).", async () => {
            const result = await request(server.getApplication())
                .post(`${baseUrl}/logo`)
                .set("Authorization", "jwt " + userToken)
                .set("Content-Type", "image/png")
                .send(png);

            expect(result.status).toBe(403);
        });

        it("Rejects a non-image content-type (400).", async () => {
            const result = await request(server.getApplication())
                .post(`${baseUrl}/logo`)
                .set("Authorization", "jwt " + adminToken)
                .set("Content-Type", "text/plain")
                .send(Buffer.from("not an image"));

            expect(result.status).toBe(400);
        });

        it("Rejects an empty body (400).", async () => {
            const result = await request(server.getApplication())
                .post(`${baseUrl}/logo`)
                .set("Authorization", "jwt " + adminToken)
                .set("Content-Type", "image/png")
                .send(Buffer.alloc(0));

            expect(result.status).toBe(400);
        });

        it("Uploads a logo and serves it back with the stored content-type.", async () => {
            const uploadResult = await request(server.getApplication())
                .post(`${baseUrl}/logo`)
                .set("Authorization", "jwt " + adminToken)
                .set("Content-Type", "image/png")
                .send(png);

            expect(uploadResult.status).toBe(200);
            expect(uploadResult.body.logoUrl).toContain("/branding/logo");

            const getResult = await request(server.getApplication()).get(`${baseUrl}/logo`);
            expect(getResult.status).toBe(200);
            expect(getResult.headers["content-type"]).toContain("image/png");
            expect(Buffer.from(getResult.body)).toEqual(png);
        });

        it("Returns 404 for GET /branding/logo when nothing has been uploaded.", async () => {
            const result = await request(server.getApplication()).get(`${baseUrl}/logo`);
            expect(result.status).toBe(404);
        });

        it("Replacing an uploaded logo deletes the previous blob.", async () => {
            const first = await request(server.getApplication())
                .post(`${baseUrl}/logo`)
                .set("Authorization", "jwt " + adminToken)
                .set("Content-Type", "image/png")
                .send(png);
            const secondPng = Buffer.from("PNG-fake-image-bytes-replaced");
            const second = await request(server.getApplication())
                .post(`${baseUrl}/logo`)
                .set("Authorization", "jwt " + adminToken)
                .set("Content-Type", "image/png")
                .send(secondPng);

            expect(second.status).toBe(200);
            expect(second.body.logoUrl).toBe(first.body.logoUrl);

            const getResult = await request(server.getApplication()).get(`${baseUrl}/logo`);
            expect(Buffer.from(getResult.body)).toEqual(secondPng);
        });

        it("Deletes the logo (trusted role only).", async () => {
            await request(server.getApplication())
                .post(`${baseUrl}/logo`)
                .set("Authorization", "jwt " + adminToken)
                .set("Content-Type", "image/png")
                .send(png);

            const forbidden = await request(server.getApplication())
                .delete(`${baseUrl}/logo`)
                .set("Authorization", "jwt " + userToken);
            expect(forbidden.status).toBe(403);

            const result = await request(server.getApplication())
                .delete(`${baseUrl}/logo`)
                .set("Authorization", "jwt " + adminToken);
            expect(result.status).toBe(204);

            const getResult = await request(server.getApplication()).get(`${baseUrl}/logo`);
            expect(getResult.status).toBe(404);
            const publicResult = await request(server.getApplication()).get(baseUrl);
            expect(publicResult.body.logoUrl).toBeFalsy();
        });
    });

    describe("POST/GET/DELETE /branding/stylesheet", () => {
        const css = Buffer.from("body { color: red; }");

        it("Rejects a non-text/css content-type (400).", async () => {
            const result = await request(server.getApplication())
                .post(`${baseUrl}/stylesheet`)
                .set("Authorization", "jwt " + adminToken)
                .set("Content-Type", "image/png")
                .send(css);

            expect(result.status).toBe(400);
        });

        it("Uploads a stylesheet and serves it back as text/css.", async () => {
            const uploadResult = await request(server.getApplication())
                .post(`${baseUrl}/stylesheet`)
                .set("Authorization", "jwt " + adminToken)
                .set("Content-Type", "text/css")
                .send(css);

            expect(uploadResult.status).toBe(200);
            expect(uploadResult.body.stylesheetUrl).toContain("/branding/stylesheet");

            const getResult = await request(server.getApplication()).get(`${baseUrl}/stylesheet`);
            expect(getResult.status).toBe(200);
            expect(getResult.headers["content-type"]).toContain("text/css");
            expect(getResult.text).toBe("body { color: red; }");
        });

        it("Setting stylesheetUrl directly clears and deletes a previously self-hosted stylesheet blob.", async () => {
            await request(server.getApplication())
                .post(`${baseUrl}/stylesheet`)
                .set("Authorization", "jwt " + adminToken)
                .set("Content-Type", "text/css")
                .send(css);

            await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ stylesheetUrl: "https://cdn.example.com/style.css" });

            const getResult = await request(server.getApplication()).get(`${baseUrl}/stylesheet`);
            expect(getResult.status).toBe(404);
        });

        it("Deletes the stylesheet (trusted role only).", async () => {
            await request(server.getApplication())
                .post(`${baseUrl}/stylesheet`)
                .set("Authorization", "jwt " + adminToken)
                .set("Content-Type", "text/css")
                .send(css);

            const result = await request(server.getApplication())
                .delete(`${baseUrl}/stylesheet`)
                .set("Authorization", "jwt " + adminToken);
            expect(result.status).toBe(204);

            const getResult = await request(server.getApplication()).get(`${baseUrl}/stylesheet`);
            expect(getResult.status).toBe(404);
        });
    });
});
