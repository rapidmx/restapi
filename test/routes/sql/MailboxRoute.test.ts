///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.sql.js";
import { request } from "@rapidrest/service-core/test";
import {
    ACLRecord,
    Server,
    ObjectFactory,
    ConnectionManager,
    ACLAction,
    AccessControlListSQL,
    isSqlDataSource,
} from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import { AuditLogEntrySQL } from "../../../src/models/sql/AuditLogEntrySQL.js";
import { DistributionListSQL } from "../../../src/models/sql/DistributionListSQL.js";
import { DomainSQL } from "../../../src/models/sql/DomainSQL.js";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { MatterSQL } from "../../../src/models/sql/MatterSQL.js";
import { computeKeyDiscoveryHash } from "../../../src/util/KeyDiscoveryClient.js";
import { AuditAction } from "../../../src/models/types.js";
import { registerTestDoubles } from "../../testDoubles.js";

describe("Route:MailboxSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/mailboxes";
    let repo: Repository<MailboxSQL>;
    let aclRepo: Repository<AccessControlListSQL>;
    let distributionListRepo: Repository<DistributionListSQL>;
    let auditLogRepo: Repository<AuditLogEntrySQL>;
    let domainRepo: Repository<DomainSQL>;
    let matterRepo: Repository<MatterSQL>;

    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const ownerToken = JWTUtils.createTokenSync(config.get("auth"), owner);
    const otherUser: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const otherUserToken = JWTUtils.createTokenSync(config.get("auth"), otherUser);
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const adminToken = JWTUtils.createTokenSync(config.get("auth"), admin);

    const createMailboxSQL = async function (data?: any, ownerUid: string = owner.uid): Promise<MailboxSQL> {
        const obj: MailboxSQL = new MailboxSQL({
            ownerUserUid: ownerUid,
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "Test Mailbox",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
            ...data,
        });

        const result: MailboxSQL = await repo.save(obj);

        const records: ACLRecord[] = [
            {
                userOrRoleId: ownerUid,
                actions: [
                    ACLAction.COUNT,
                    ACLAction.CREATE,
                    ACLAction.DELETE,
                    ACLAction.EXISTS,
                    ACLAction.LIST,
                    ACLAction.READ,
                    ACLAction.TRUNCATE,
                    ACLAction.UPDATE,
                ],
            },
        ];

        await aclRepo.save({
            uid: result.uid,
            dateCreated: new Date(),
            dateModified: new Date(),
            version: 0,
            records,
            parentUid: "Mailbox",
        });

        return result;
    };

    const createMatter = async function (data?: any): Promise<MatterSQL> {
        const obj: MatterSQL = new MatterSQL({
            name: "Test Matter",
            escrowScopeId: uuid.v4(),
            custodianMailboxUids: [],
            dateRangeStart: new Date("2020-01-01"),
            dateRangeEnd: new Date("2030-01-01"),
            ...data,
        });
        return await matterRepo.save(obj);
    };

    // dateCreated, dateModified, uid and version are assigned by the server. `_id` never applies to a SQL
    // model but is harmless to keep excluded for parity with the Mongo original.
    // `keyDiscoveryHash` is derived from `primarySmtpAddress` by `BaseMailboxRoute.create()`, the same way
    // `uid` itself is - not meaningfully asserted via deep equality against a caller-constructed `Mailbox`
    // instance, whose own class-level default for the field is `undefined`.
    const SERVER_ASSIGNED_FIELDS = ["uid", "dateCreated", "dateModified", "version", "_id", "keyDiscoveryHash"];

    const expectMatchingFields = function (actual: any, expected: any): void {
        for (const key in expected) {
            if (SERVER_ASSIGNED_FIELDS.includes(key)) {
                continue;
            }
            // A nullable SQL column left unset round-trips as `null`, not `undefined` (unlike the in-memory
            // object literal, whose class field declares the property with value `undefined` but never
            // assigns it) - normalize both to `undefined` so this is treated as "no value" either way, rather
            // than a real mismatch.
            expect(actual[key] ?? undefined).toEqual(expected[key] ?? undefined);
        }
        expect(actual.uid).toBeDefined();
        expect(new Date(actual.dateCreated).getTime()).not.toBeNaN();
        expect(new Date(actual.dateModified).getTime()).not.toBeNaN();
    };

    beforeAll(async () => {
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        let conn: any = connMgr?.connections.get("acl");
        if (isSqlDataSource(conn)) {
            aclRepo = conn.getRepository(AccessControlListSQL);
        } else {
            throw new Error("Could not find sql acl connection");
        }
        conn = connMgr?.connections.get("sql");
        if (isSqlDataSource(conn)) {
            repo = conn.getRepository(MailboxSQL);
            distributionListRepo = conn.getRepository(DistributionListSQL);
            auditLogRepo = conn.getRepository(AuditLogEntrySQL);
            domainRepo = conn.getRepository(DomainSQL);
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
        await repo.clear();
        await distributionListRepo.clear();
        await auditLogRepo.clear();
        await domainRepo.clear();
        await matterRepo.clear();
    });

    it("Listing mailboxes anonymously (no Authorization header) returns an empty list, not another user's data.", async () => {
        await createMailboxSQL();
        const result = await request(server.getApplication()).get(baseUrl);
        expect(result.status).toBe(200);
        expect(result.body).toEqual([]);
    });

    it("A trusted caller can create a mailbox owned by a user. (Self-service creation: see mailboxSelfServiceCreateSuite.ts.)", async () => {
        const obj: MailboxSQL = new MailboxSQL({
            ownerUserUid: owner.uid,
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: ["alias@example.com"],
            displayName: "My Mailbox",
            timezone: "America/Los_Angeles",
            quotaBytes: 5_000_000_000,
            usedBytes: 0,
        });

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send(obj);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expectMatchingFields(result.body, obj);
        expect(result.body.keyDiscoveryHash).toBe(computeKeyDiscoveryHash(obj.primarySmtpAddress.split("@")[0]));

        const existing: MailboxSQL | null = await repo.findOne({ where: { uid: result.body.uid } });
        expect(existing).toBeDefined();
        if (existing) {
            expectMatchingFields(existing, obj);
        }
    });

    it("Owner can read their own mailbox by id.", async () => {
        const obj = await createMailboxSQL();

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${obj.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expectMatchingFields(result.body, obj);
    });

    it("A different authenticated user cannot read someone else's mailbox by id - 404, exactly as for a mailbox that doesn't exist, so the answer reveals no address.", async () => {
        const obj = await createMailboxSQL();

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${obj.uid}`)
            .set("Authorization", "jwt " + otherUserToken);
        const missing = await request(server.getApplication())
            .get(`${baseUrl}/${uuid.v4()}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(404);
        expect(missing.status).toBe(404);
        expect(result.body).toEqual(missing.body);
    });

    it("Does not audit an owner reading their own mailbox profile.", async () => {
        const obj = await createMailboxSQL();

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${obj.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        const entries = await auditLogRepo.find({ where: { targetUid: obj.uid } });
        expect(entries.some((e) => e.action === AuditAction.MAILBOX_ACCESSED)).toBe(false);
    });

    it("A trusted admin cannot read another user's mailbox profile (404, like a mailbox that doesn't exist) - only `?scope=admin` shows its administrative metadata, audited.", async () => {
        const obj = await createMailboxSQL({ oofMessage: "Away until Monday" });

        const plain = await request(server.getApplication())
            .get(`${baseUrl}/${obj.uid}`)
            .set("Authorization", "jwt " + adminToken);
        expect(plain.status).toBe(404);
        const missing = await request(server.getApplication())
            .get(`${baseUrl}/${uuid.v4()}`)
            .set("Authorization", "jwt " + adminToken);
        expect(missing.status).toBe(404);
        expect(await auditLogRepo.find({ where: { targetUid: obj.uid } })).toEqual([]);

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${obj.uid}?scope=admin`)
            .set("Authorization", "jwt " + adminToken);

        expect(result.status).toBe(200);
        expect(result.body.primarySmtpAddress).toBe(obj.primarySmtpAddress);
        expect(result.body.shared).toBe(false);
        // Metadata only: nothing of the owner's own settings.
        expect(result.body.oofMessage).toBeUndefined();
        expect(result.body.keys).toBeUndefined();
        const entries = await auditLogRepo.find({ where: { targetUid: obj.uid } });
        expect(entries.length).toBe(1);
        expect(entries[0].action).toBe(AuditAction.MAILBOX_ADMIN_READ);
        expect(entries[0].actorUserUid).toBe(admin.uid);
    });

    it("`?scope=admin` needs a trusted role (403 api-103) and an elevated token (403 api-104).", async () => {
        const obj = await createMailboxSQL();
        const ordinary = await request(server.getApplication())
            .get(`${baseUrl}/${obj.uid}?scope=admin`)
            .set("Authorization", "jwt " + ownerToken);
        expect(ordinary.status).toBe(403);
        expect(ordinary.body.code).toBe("api-103");

        const unelevatedAdmin = JWTUtils.createTokenSync(config.get("auth"), { uid: admin.uid, roles: ["admin"], scopes: [] });
        const result = await request(server.getApplication())
            .get(`${baseUrl}?scope=admin`)
            .set("Authorization", "jwt " + unelevatedAdmin);
        expect(result.status).toBe(403);
        expect(result.body.code).toBe("api-104");
    });

    it("A different authenticated user's list of mailboxes does not include another user's mailbox.", async () => {
        await createMailboxSQL({ displayName: "Owner's mailbox" });
        await createMailboxSQL({ displayName: "Other user's mailbox" }, otherUser.uid);

        const result = await request(server.getApplication())
            .get(baseUrl)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(Array.isArray(result.body)).toBe(true);
        expect(result.body.length).toBe(1);
        expect(result.body[0].displayName).toBe("Owner's mailbox");
    });

    it("Escapes %/_ in a role-based ACL grant's userOrRoleId so it can't accidentally wildcard-match an unrelated role's mailbox.", async () => {
        const wildcardRole = "support%team";
        const lookalikeRole = "supportXteam";
        const wanted = await createMailboxSQL({ displayName: "Shared with support%team" });
        const lookalike = await createMailboxSQL({ displayName: "Shared with supportXteam" });
        await aclRepo.save({
            uid: wanted.uid,
            dateCreated: new Date(),
            dateModified: new Date(),
            version: 0,
            records: [{ userOrRoleId: wildcardRole, actions: [ACLAction.READ] }],
            parentUid: "Mailbox",
        } as any);
        await aclRepo.save({
            uid: lookalike.uid,
            dateCreated: new Date(),
            dateModified: new Date(),
            version: 0,
            records: [{ userOrRoleId: lookalikeRole, actions: [ACLAction.READ] }],
            parentUid: "Mailbox",
        } as any);
        const supportUser: any = { uid: uuid.v4(), roles: [wildcardRole], elevated: Date.now() };
        const supportToken = JWTUtils.createTokenSync(config.get("auth"), supportUser);

        const result = await request(server.getApplication())
            .get(baseUrl)
            .set("Authorization", "jwt " + supportToken);

        expect(result.status).toBe(200);
        expect(result.body.map((m: any) => m.uid)).toEqual([wanted.uid]);
    });

    it("Owner can update their own mailbox.", async () => {
        const obj = await createMailboxSQL();

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${obj.uid}`)
            .set("Authorization", "jwt " + ownerToken)
            .send({ uid: obj.uid, version: obj.version, displayName: "Renamed Mailbox" });

        expect(result.status).toBe(200);
        expect(result.body.displayName).toBe("Renamed Mailbox");
    });

    it("Recomputes keyDiscoveryHash when primarySmtpAddress is patched, leaving it alone otherwise.", async () => {
        const obj = await createMailboxSQL();
        const originalHash = obj.keyDiscoveryHash;

        const unrelatedUpdate = await request(server.getApplication())
            .put(`${baseUrl}/${obj.uid}`)
            .set("Authorization", "jwt " + ownerToken)
            .send({ uid: obj.uid, version: obj.version, displayName: "Renamed Mailbox" });
        expect(unrelatedUpdate.body.keyDiscoveryHash).toBe(originalHash);

        const newAddress = `${uuid.v4()}@example.com`;
        const addressUpdate = await request(server.getApplication())
            .put(`${baseUrl}/${obj.uid}`)
            .set("Authorization", "jwt " + adminToken)
            .send({ uid: obj.uid, version: unrelatedUpdate.body.version, primarySmtpAddress: newAddress });

        // An administrator with no grant is answered with metadata only - the hash is read back as the owner.
        expect(addressUpdate.status).toBe(200);
        expect(addressUpdate.body.primarySmtpAddress).toBe(newAddress);
        expect(addressUpdate.body.keyDiscoveryHash).toBeUndefined();
        const stored = await request(server.getApplication())
            .get(`${baseUrl}/${obj.uid}`)
            .set("Authorization", "jwt " + ownerToken);
        expect(stored.body.keyDiscoveryHash).toBe(computeKeyDiscoveryHash(newAddress.split("@")[0]));
        expect(stored.body.keyDiscoveryHash).not.toBe(originalHash);
    });

    it("A different authenticated user cannot update someone else's mailbox.", async () => {
        const obj = await createMailboxSQL();

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${obj.uid}`)
            .set("Authorization", "jwt " + otherUserToken)
            .send({ uid: obj.uid, version: obj.version, displayName: "Hijacked" });

        expect(result.status).toBe(403);
    });

    it("Rejects a client attempting to directly set 'keys' via PUT (400) - only the CA-enrollment path may publish keys.", async () => {
        const obj = await createMailboxSQL();

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${obj.uid}`)
            .set("Authorization", "jwt " + ownerToken)
            .send({
                uid: obj.uid,
                version: obj.version,
                keys: [{ publicKey: "forged-b64", type: "x509", useType: "encrypt", fingerprint: "forged-fp", notBefore: 0, notAfter: Date.now() + 1_000_000 }],
            });

        expect(result.status).toBe(400);
    });

    it("Rejects a client attempting to directly set 'keyDiscoveryHash' via PUT (400) - collision with another address's hash would impersonate it at the discovery endpoint.", async () => {
        const obj = await createMailboxSQL();

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${obj.uid}`)
            .set("Authorization", "jwt " + ownerToken)
            .send({ uid: obj.uid, version: obj.version, keyDiscoveryHash: "attacker-chosen-hash" });

        expect(result.status).toBe(400);
    });

    it("Allows a full-object PUT carrying an empty 'keys' array (the class default, not a client assertion).", async () => {
        const obj = await createMailboxSQL();

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${obj.uid}`)
            .set("Authorization", "jwt " + ownerToken)
            .send(new MailboxSQL({ ...obj, displayName: "Still Fine" }));

        expect(result.status).toBe(200);
        expect(result.body.displayName).toBe("Still Fine");
    });

    it("Redirects a single-property update of primarySmtpAddress through the full update path, keeping keyDiscoveryHash in sync (updateProperty()).", async () => {
        const obj = await createMailboxSQL();
        const newAddress = `${uuid.v4()}@example.com`;

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${obj.uid}/primarySmtpAddress`)
            .set("Authorization", "jwt " + adminToken)
            .send(newAddress);

        expect(result.status).toBe(200);
        expect(result.body.primarySmtpAddress).toBe(newAddress);
        const stored = await request(server.getApplication())
            .get(`${baseUrl}/${obj.uid}`)
            .set("Authorization", "jwt " + ownerToken);
        expect(stored.body.keyDiscoveryHash).toBe(computeKeyDiscoveryHash(newAddress.split("@")[0]));
    });

    it("Rejects renaming a mailbox's primarySmtpAddress to an address already used by an existing DistributionList (409) - previously let a self-service owner silently hijack a list's mail flow.", async () => {
        const address = `${uuid.v4()}@example.com`;
        await distributionListRepo.save(
            new DistributionListSQL({
                uid: address,
                primarySmtpAddress: address,
                aliasAddresses: [],
                name: "Existing List",
                memberAddresses: [],
            } as any),
        );

        const obj = await createMailboxSQL();
        const result = await request(server.getApplication())
            .put(`${baseUrl}/${obj.uid}/primarySmtpAddress`)
            .set("Authorization", "jwt " + adminToken)
            .send(address);

        expect(result.status).toBe(409);

        const unchanged = await repo.findOne({ where: { uid: obj.uid } });
        expect(unchanged?.primarySmtpAddress).toBe(obj.primarySmtpAddress);
    });

    it("Rejects renaming a mailbox's primarySmtpAddress to an address already used by another Mailbox (409), via a raw PUT of the whole object.", async () => {
        const other = await createMailboxSQL();
        const obj = await createMailboxSQL();

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${obj.uid}`)
            .set("Authorization", "jwt " + adminToken)
            .send({ uid: obj.uid, version: obj.version, primarySmtpAddress: other.primarySmtpAddress });

        expect(result.status).toBe(409);
    });

    it("Rejects renaming primarySmtpAddress to an unverified domain once this server has at least one verified domain (400).", async () => {
        await domainRepo.save(new DomainSQL({ name: "example.com", enabled: true, verified: true }));
        const obj = await createMailboxSQL({ primarySmtpAddress: `${uuid.v4()}@example.com` });

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${obj.uid}`)
            .set("Authorization", "jwt " + adminToken)
            .send({ uid: obj.uid, version: obj.version, primarySmtpAddress: `${uuid.v4()}@not-verified.com` });

        expect(result.status).toBe(400);
    });

    it("Allows renaming primarySmtpAddress to an address on a verified domain.", async () => {
        await domainRepo.save(new DomainSQL({ name: "example.com", enabled: true, verified: true }));
        const obj = await createMailboxSQL({ primarySmtpAddress: `${uuid.v4()}@example.com` });
        const newAddress = `${uuid.v4()}@example.com`;

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${obj.uid}`)
            .set("Authorization", "jwt " + adminToken)
            .send({ uid: obj.uid, version: obj.version, primarySmtpAddress: newAddress });

        expect(result.status).toBe(200);
        expect(result.body.primarySmtpAddress).toBe(newAddress);
    });

    it("Refuses (403) a non-trusted owner renaming primarySmtpAddress to an address that isn't one of their own usernames - by PUT, property PUT or bulk PUT - leaving it unchanged. (Renames onto the owner's own username: see mailboxSelfServiceCreateSuite.ts.)", async () => {
        const obj = await createMailboxSQL();
        const newAddress = `ceo-${uuid.v4()}@example.com`;

        const put = await request(server.getApplication())
            .put(`${baseUrl}/${obj.uid}`)
            .set("Authorization", "jwt " + ownerToken)
            .send({ uid: obj.uid, version: obj.version, primarySmtpAddress: newAddress });
        expect(put.status).toBe(403);
        expect(put.body.message).toBe("You can only change your mailbox's address to one of your own usernames on this server's domains.");

        const property = await request(server.getApplication())
            .put(`${baseUrl}/${obj.uid}/primarySmtpAddress`)
            .set("Authorization", "jwt " + ownerToken)
            .send(newAddress);
        expect(property.status).toBe(403);

        // `CRUDRoute`'s bulk validator reports a `BulkError` carrying the first failed element's own status
        // (service-core 2.1.0; it was a blanket 400 before), with that element's reason kept.
        const bulk = await request(server.getApplication())
            .put(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send([{ uid: obj.uid, version: obj.version, primarySmtpAddress: newAddress }]);
        expect(bulk.status).toBe(403);

        const unchanged = await repo.findOne({ where: { uid: obj.uid } });
        expect(unchanged?.primarySmtpAddress).toBe(obj.primarySmtpAddress);
    });

    it("Allows a PUT that resends the mailbox's own current, unchanged primarySmtpAddress (200) - re-validating only on a genuine change.", async () => {
        const obj = await createMailboxSQL();

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${obj.uid}`)
            .set("Authorization", "jwt " + ownerToken)
            .send({ uid: obj.uid, version: obj.version, primarySmtpAddress: obj.primarySmtpAddress, displayName: "Still Fine" });

        expect(result.status).toBe(200);
        expect(result.body.displayName).toBe("Still Fine");
    });

    it("Keeps keyDiscoveryHash in sync for a bulk update too (updateBulk()) - the earlier update()-only override missed this path entirely.", async () => {
        const obj = await createMailboxSQL();
        const newAddress = `${uuid.v4()}@example.com`;

        const result = await request(server.getApplication())
            .put(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send([{ uid: obj.uid, version: obj.version, primarySmtpAddress: newAddress }]);

        expect(result.status).toBe(200);
        expect(result.body[0].primarySmtpAddress).toBe(newAddress);
        const stored = await request(server.getApplication())
            .get(`${baseUrl}/${obj.uid}`)
            .set("Authorization", "jwt " + ownerToken);
        expect(stored.body.keyDiscoveryHash).toBe(computeKeyDiscoveryHash(newAddress.split("@")[0]));
    });

    it("Returns 404 patching primarySmtpAddress via updateProperty() on a mailbox that doesn't exist.", async () => {
        const result = await request(server.getApplication())
            .put(`${baseUrl}/${uuid.v4()}/primarySmtpAddress`)
            .set("Authorization", "jwt " + ownerToken)
            .send("new-address@example.com");

        expect(result.status).toBe(404);
    });

    it("A single-property update() of an ordinary field (not primarySmtpAddress) still works normally.", async () => {
        const obj = await createMailboxSQL();

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${obj.uid}/displayName`)
            .set("Authorization", "jwt " + ownerToken)
            .send("Renamed Via Property");

        expect(result.status).toBe(200);
        expect(result.body.displayName).toBe("Renamed Via Property");
    });

    it("Deleting a nonexistent mailbox returns 404.", async () => {
        const result = await request(server.getApplication())
            .delete(`${baseUrl}/${uuid.v4()}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(404);
    });

    it("Owner can delete their own mailbox.", async () => {
        const obj = await createMailboxSQL();

        const result = await request(server.getApplication())
            .delete(`${baseUrl}/${obj.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);

        const existing: MailboxSQL | null = await repo.findOne({ where: { uid: obj.uid } });
        expect(existing).toBeNull();
    });

    describe("legal hold", () => {
        it("Blocks deleting a mailbox under an open Matter's hold, auditing the block.", async () => {
            const obj = await createMailboxSQL();
            await createMatter({ custodianMailboxUids: [obj.uid] });

            const result = await request(server.getApplication())
                .delete(`${baseUrl}/${obj.uid}`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(409);
            const stillExists: MailboxSQL | null = await repo.findOne({ where: { uid: obj.uid } });
            expect(stillExists).toBeTruthy();

            const entries = await auditLogRepo.find({ where: { targetUid: obj.uid } });
            expect(entries.some((e) => e.action === AuditAction.LEGAL_HOLD_BLOCKED_DELETE)).toBe(true);
        });

        it("Allows deleting a mailbox once the matter is closed.", async () => {
            const obj = await createMailboxSQL();
            await createMatter({ custodianMailboxUids: [obj.uid], closedAt: new Date() });

            const result = await request(server.getApplication())
                .delete(`${baseUrl}/${obj.uid}`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
        });

        it("Allows deleting a mailbox not named as a custodian on any open matter.", async () => {
            const obj = await createMailboxSQL();
            await createMatter({ custodianMailboxUids: [uuid.v4()] });

            const result = await request(server.getApplication())
                .delete(`${baseUrl}/${obj.uid}`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
        });

        it("Blocks a bulk truncate() of a mailbox under an open Matter's hold - a caller cannot route around the singular delete guard by using the bulk endpoint instead.", async () => {
            // `Mailbox`'s class-level ACL denies everyone but a trusted (admin) caller by default (see
            // `MailboxSQL`'s own `@Protect` policy) - a bulk `DELETE /mailboxes` is only actually reachable
            // by that trusted caller, unlike the per-mailbox `DELETE /mailboxes/:id` any owner can reach.
            const obj = await createMailboxSQL();
            await createMatter({ custodianMailboxUids: [obj.uid] });

            const result = await request(server.getApplication()).delete(baseUrl).set("Authorization", "jwt " + adminToken);

            expect(result.status).toBe(409);
            const stillExists: MailboxSQL | null = await repo.findOne({ where: { uid: obj.uid } });
            expect(stillExists).toBeTruthy();
        });

        it("Allows a bulk truncate() of a mailbox once the matter is closed.", async () => {
            const obj = await createMailboxSQL();
            await createMatter({ custodianMailboxUids: [obj.uid], closedAt: new Date() });

            const result = await request(server.getApplication()).delete(baseUrl).set("Authorization", "jwt " + adminToken);

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
            const stillExists: MailboxSQL | null = await repo.findOne({ where: { uid: obj.uid } });
            expect(stillExists).toBeNull();
        });

        it("A bulk truncate() that matches no mailboxes at all succeeds as a no-op.", async () => {
            const result = await request(server.getApplication()).delete(baseUrl).set("Authorization", "jwt " + adminToken);

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
        });
    });

    it("Can make a count request scoped to the caller's own mailboxes.", async () => {
        await createMailboxSQL();
        await createMailboxSQL();
        await createMailboxSQL({}, otherUser.uid);

        const result = await request(server.getApplication())
            .head(baseUrl)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.headers["content-length"]).toBe("2");
    });

    it("A caller with a delegate ACL grant (not owner) sees a shared mailbox in their list, alongside their own.", async () => {
        await createMailboxSQL({ displayName: "Owner's own mailbox" });
        const shared = await createMailboxSQL({ displayName: "Shared Mailbox" }, otherUser.uid);

        const acl: any = await aclRepo.findOne({ where: { uid: shared.uid } });
        acl.records.push({ userOrRoleId: owner.uid, actions: [ACLAction.READ, ACLAction.LIST] });
        await aclRepo.save(acl);

        const result = await request(server.getApplication())
            .get(baseUrl)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        const names = result.body.map((m: any) => m.displayName).sort();
        expect(names).toEqual(["Owner's own mailbox", "Shared Mailbox"]);
    });

    it("A trusted (admin) caller's plain list is only their own and shared-with-them mailboxes - here none - and `?scope=admin` lists every mailbox as metadata, audited.", async () => {
        await createMailboxSQL({ displayName: "Owner's mailbox", oofMessage: "Away" });
        await createMailboxSQL({ displayName: "Other user's mailbox" }, otherUser.uid);

        const plain = await request(server.getApplication())
            .get(baseUrl)
            .set("Authorization", "jwt " + adminToken);
        expect(plain.status).toBe(200);
        expect(plain.body).toEqual([]);

        const result = await request(server.getApplication())
            .get(`${baseUrl}?scope=admin`)
            .set("Authorization", "jwt " + adminToken);

        expect(result.status).toBe(200);
        const names = result.body.map((m: any) => m.displayName).sort();
        expect(names).toEqual(["Other user's mailbox", "Owner's mailbox"]);
        expect(result.body.every((m: any) => m.oofMessage === undefined && m.keys === undefined && typeof m.shared === "boolean")).toBe(true);
        const entries = await auditLogRepo.find({ where: { action: AuditAction.MAILBOX_ADMIN_LIST } });
        expect(entries.length).toBe(1);
        expect(entries[0].actorUserUid).toBe(admin.uid);
        expect(entries[0].details.count).toBe(2);
    });

    it("`?scope=admin` can't be used to probe a field it doesn't show (filtering by the out-of-office text is ignored).", async () => {
        await createMailboxSQL({ displayName: "Has OOF", oofMessage: "secret-oof" });
        await createMailboxSQL({ displayName: "No OOF" }, otherUser.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}?scope=admin&oofMessage=secret-oof`)
            .set("Authorization", "jwt " + adminToken);

        expect(result.status).toBe(200);
        expect(result.body.length).toBe(2);
    });

    it("A trusted (admin) caller's count is only their own and shared-with-them mailboxes, and every mailbox with `?scope=admin`.", async () => {
        await createMailboxSQL();
        await createMailboxSQL({}, otherUser.uid);

        const plain = await request(server.getApplication())
            .head(baseUrl)
            .set("Authorization", "jwt " + adminToken);
        expect(plain.status).toBe(200);
        expect(plain.headers["content-length"]).toBe("0");

        const result = await request(server.getApplication())
            .head(`${baseUrl}?scope=admin`)
            .set("Authorization", "jwt " + adminToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.headers["content-length"]).toBe("2");
    });

    it("A non-trusted caller can't create a mailbox directly while self-service mailboxes aren't set up (403) - no verified domains here.", async () => {
        const obj: MailboxSQL = new MailboxSQL({
            ownerUserUid: otherUser.uid,
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "Claimed Mailbox",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
        });

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send(obj);

        expect(result.status).toBe(403);
        expect(await repo.find()).toEqual([]);
    });

    it("A trusted (admin) caller can create a true ownerless shared mailbox by omitting ownerUserUid.", async () => {
        const obj: any = {
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "Shared Support Mailbox",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
        };

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send(obj);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body.ownerUserUid == null).toBe(true);

        // An administrator has no implicit access to any mailbox, so the one who creates a shared mailbox is granted it
        // explicitly (full rights) - and appears in the list of "their" mailboxes.
        const acl: any = await aclRepo.findOne({ where: { uid: result.body.uid } });
        expect(acl?.records ?? []).toEqual([{ userOrRoleId: admin.uid, actions: ["*"] }]);
        const mine = await request(server.getApplication())
            .get(baseUrl)
            .set("Authorization", "jwt " + adminToken);
        expect(mine.body.map((m: any) => m.uid)).toEqual([result.body.uid]);
    });

    it("Writes an AuditLogEntry when a trusted caller creates a mailbox (self-service creation isn't audited - see mailboxSelfServiceCreateSuite.ts).", async () => {
        const sharedResult = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({
                primarySmtpAddress: `${uuid.v4()}@example.com`,
                aliasAddresses: [],
                displayName: "Shared Support Mailbox",
                timezone: "UTC",
                quotaBytes: 1_000_000_000,
                usedBytes: 0,
            });
        expect(sharedResult.status).toBeGreaterThanOrEqual(200);
        expect(sharedResult.status).toBeLessThan(300);

        const sharedEntries = await auditLogRepo.find({ where: { targetUid: sharedResult.body.uid } });
        expect(sharedEntries.length).toBe(1);
        expect(sharedEntries[0].action).toBe(AuditAction.MAILBOX_CREATE);
        expect(sharedEntries[0].targetType).toBe("Mailbox");
        expect(sharedEntries[0].mailboxUid).toBe(sharedResult.body.uid);
        expect(sharedEntries[0].actorUserUid).toBe(admin.uid);
    });

    it("Rejects a non-trusted caller creating a resource mailbox (403).", async () => {
        const obj: any = {
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "Conference Room",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
            isResource: true,
        };

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send(obj);

        expect(result.status).toBe(403);
    });

    it("A trusted (admin) caller can create a resource mailbox, and its resource fields round-trip.", async () => {
        const obj: any = {
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "Conference Room",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
            isResource: true,
            resourceType: "room",
            resourceCapacity: 12,
            autoAcceptBookings: true,
            allowConflicts: false,
            bookingWindowDays: 90,
            maxDurationMinutes: 120,
        };

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send(obj);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body.ownerUserUid == null).toBe(true);
        expectMatchingFields(result.body, obj);
    });

    it("Creating a mailbox eagerly provisions every well-known folder (the webmail client needs each to render anything at all).", async () => {
        const obj: MailboxSQL = new MailboxSQL({
            ownerUserUid: owner.uid,
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "Fresh Mailbox",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
        });

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send(obj);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);

        const folders = await request(server.getApplication())
            .get(`/sql/folders?mailboxUid=${result.body.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        // Read as the mailbox's owner: the administrator who created it has no access to its folders.
        expect(folders.status).toBe(200);
        const types = folders.body.map((f: any) => f.type).sort();
        expect(types).toEqual([
            "archive",
            "calendar",
            "contacts",
            "deleted_items",
            "drafts",
            "inbox",
            "junk",
            "notes",
            "outbox",
            "sent_items",
            "tasks",
        ]);
    });

    it("An admin can still create a mailbox for themselves like any other authenticated user.", async () => {
        const obj: MailboxSQL = new MailboxSQL({
            ownerUserUid: admin.uid,
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "Admin Mailbox",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
        });

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send(obj);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expectMatchingFields(result.body, obj);
    });

    describe("escrowScopeId assignment", () => {
        it("Rejects creating a mailbox with escrowScopeId already set (400), even for a trusted admin.", async () => {
            const obj: any = {
                ownerUserUid: admin.uid,
                primarySmtpAddress: `${uuid.v4()}@example.com`,
                aliasAddresses: [],
                displayName: "Test Mailbox",
                timezone: "UTC",
                quotaBytes: 1_000_000_000,
                usedBytes: 0,
                escrowScopeId: uuid.v4(),
            };

            const result = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send(obj);

            expect(result.status).toBe(400);
        });

        it("A non-trusted owner cannot assign their own mailbox to an escrow scope (403).", async () => {
            const obj = await createMailboxSQL();

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${obj.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ uid: obj.uid, version: obj.version, escrowScopeId: uuid.v4() });

            expect(result.status).toBe(403);
        });

        it("A trusted admin cannot assign a mailbox to a nonexistent escrow scope (404).", async () => {
            const obj = await createMailboxSQL();

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${obj.uid}`)
                .set("Authorization", "jwt " + adminToken)
                .send({ uid: obj.uid, version: obj.version, escrowScopeId: uuid.v4() });

            expect(result.status).toBe(404);
        });

        it("A trusted admin can assign a mailbox to an existing escrow scope.", async () => {
            const obj = await createMailboxSQL();
            const scopeResult = await request(server.getApplication())
                .post("/sql/escrow-scopes")
                .set("Authorization", "jwt " + adminToken)
                .send({
                    name: "legal",
                    publicKey: { publicKey: "cert", type: "x509", fingerprint: "fp1", notBefore: 0, notAfter: 1 },
                    holderUserUids: [uuid.v4()],
                    requiredHolders: 1,
                });
            expect(scopeResult.status).toBeGreaterThanOrEqual(200);

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${obj.uid}`)
                .set("Authorization", "jwt " + adminToken)
                .send({ uid: obj.uid, version: obj.version, escrowScopeId: scopeResult.body.uid });

            expect(result.status).toBe(200);
            expect(result.body.escrowScopeId).toBe(scopeResult.body.uid);
        });

        it("A trusted admin can unassign a mailbox's escrow scope by setting it back to null.", async () => {
            const scopeResult = await request(server.getApplication())
                .post("/sql/escrow-scopes")
                .set("Authorization", "jwt " + adminToken)
                .send({
                    name: "legal",
                    publicKey: { publicKey: "cert", type: "x509", fingerprint: "fp1", notBefore: 0, notAfter: 1 },
                    holderUserUids: [uuid.v4()],
                    requiredHolders: 1,
                });
            const obj = await createMailboxSQL({ escrowScopeId: scopeResult.body.uid });

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${obj.uid}`)
                .set("Authorization", "jwt " + adminToken)
                .send({ uid: obj.uid, version: obj.version, escrowScopeId: null });

            expect(result.status).toBe(200);
            expect(result.body.escrowScopeId == null).toBe(true);
        });

        it("Leaves escrowScopeId alone when a patch doesn't touch it.", async () => {
            const scopeResult = await request(server.getApplication())
                .post("/sql/escrow-scopes")
                .set("Authorization", "jwt " + adminToken)
                .send({
                    name: "legal",
                    publicKey: { publicKey: "cert", type: "x509", fingerprint: "fp1", notBefore: 0, notAfter: 1 },
                    holderUserUids: [uuid.v4()],
                    requiredHolders: 1,
                });
            const obj = await createMailboxSQL({ escrowScopeId: scopeResult.body.uid });

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${obj.uid}`)
                .set("Authorization", "jwt " + adminToken)
                .send({ uid: obj.uid, version: obj.version, displayName: "Renamed" });

            expect(result.status).toBe(200);
            expect(result.body.escrowScopeId).toBe(scopeResult.body.uid);
        });
    });

    it("An authenticated user with no mailboxes/ACL grants at all sees an empty list, not every mailbox.", async () => {
        await createMailboxSQL();
        const freshUser: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
        const freshToken = JWTUtils.createTokenSync(config.get("auth"), freshUser);

        const result = await request(server.getApplication())
            .get(baseUrl)
            .set("Authorization", "jwt " + freshToken);

        expect(result.status).toBe(200);
        expect(result.body).toEqual([]);
    });

    it("A count request from an authenticated user with no mailboxes/ACL grants at all returns 0.", async () => {
        await createMailboxSQL();
        const freshUser: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
        const freshToken = JWTUtils.createTokenSync(config.get("auth"), freshUser);

        const result = await request(server.getApplication())
            .head(baseUrl)
            .set("Authorization", "jwt " + freshToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.headers["content-length"]).toBe("0");
    });

    it("Auto-provisioning is disabled by default (404) — see MailboxAutoProvision.test.ts for the enabled-config behavior.", async () => {
        const result = await request(server.getApplication())
            .post(`${baseUrl}/auto-provision`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(404);
    });

    it("Rejects creating a mailbox whose address is already used by an existing DistributionList (409).", async () => {
        const address = `${uuid.v4()}@example.com`;
        await distributionListRepo.save(
            new DistributionListSQL({
                uid: address,
                primarySmtpAddress: address,
                aliasAddresses: [],
                name: "Existing List",
                memberAddresses: [],
            } as any),
        );

        const obj: MailboxSQL = new MailboxSQL({
            ownerUserUid: owner.uid,
            primarySmtpAddress: address,
            aliasAddresses: [],
            displayName: "Collides",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
        });

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send(obj);

        expect(result.status).toBe(409);
    });

    it("Rejects creating a mailbox with no primarySmtpAddress (400).", async () => {
        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({ ownerUserUid: owner.uid, displayName: "No Address", timezone: "UTC", quotaBytes: 1, usedBytes: 0 });

        expect(result.status).toBe(400);
    });

    it("Rejects a bulk create request with two mailboxes claiming the same address (409).", async () => {
        const address = `${uuid.v4()}@example.com`;
        const objs = [
            new MailboxSQL({
                ownerUserUid: owner.uid,
                primarySmtpAddress: address,
                aliasAddresses: [],
                displayName: "One",
                timezone: "UTC",
                quotaBytes: 1_000_000_000,
                usedBytes: 0,
            }),
            new MailboxSQL({
                ownerUserUid: owner.uid,
                primarySmtpAddress: address,
                aliasAddresses: [],
                displayName: "Two",
                timezone: "UTC",
                quotaBytes: 1_000_000_000,
                usedBytes: 0,
            }),
        ];

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send(objs);

        expect(result.status).toBe(409);
    });

    it("A created mailbox's uid and stored addresses are the normalized (lowercased) addresses.", async () => {
        const address = `Mixed.Case.${uuid.v4()}@Example.com`;
        const obj: MailboxSQL = new MailboxSQL({
            ownerUserUid: owner.uid,
            primarySmtpAddress: address,
            aliasAddresses: ["Alias.Case@Example.com"],
            displayName: "Case Test",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
        });

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send(obj);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body.uid).toBe(address.toLowerCase());
        expect(result.body.primarySmtpAddress).toBe(address.toLowerCase());
        expect(result.body.aliasAddresses).toEqual(["alias.case@example.com"]);
    });
});
