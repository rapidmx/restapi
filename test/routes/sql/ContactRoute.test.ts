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
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { FolderSQL } from "../../../src/models/sql/FolderSQL.js";
import { ContactSQL } from "../../../src/models/sql/ContactSQL.js";
import { ContactAddressKind, FolderType } from "../../../src/models/types.js";
import { registerTestDoubles, type InMemoryBlobStore } from "../../testDoubles.js";
import { openSealedField, testZeroAccessKey } from "../../zeroAccessTestKeys.js";

describe("Route:ContactSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/contacts";
    let mailboxRepo: Repository<MailboxSQL>;
    let folderRepo: Repository<FolderSQL>;
    let contactRepo: Repository<ContactSQL>;
    let aclRepo: Repository<AccessControlListSQL>;

    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const ownerToken = JWTUtils.createTokenSync(config.get("auth"), owner);
    const otherUser: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const otherUserToken = JWTUtils.createTokenSync(config.get("auth"), otherUser);

    const createMailbox = async function (ownerUid: string): Promise<MailboxSQL> {
        const obj: MailboxSQL = new MailboxSQL({
            ownerUserUid: ownerUid,
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "Test Mailbox",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
        });
        const result: MailboxSQL = await mailboxRepo.save(obj);
        await aclRepo.save({
            uid: result.uid,
            dateCreated: new Date(),
            dateModified: new Date(),
            version: 0,
            records: [{ userOrRoleId: ownerUid, actions: [ACLAction.FULL] }],
            parentUid: "Mailbox",
        });
        return result;
    };

    const createFolder = async function (mailboxUid: string, data?: any): Promise<FolderSQL> {
        const obj: FolderSQL = new FolderSQL({
            mailboxUid,
            name: "Contacts",
            type: FolderType.CONTACTS,
            unreadCount: 0,
            totalCount: 0,
            syncKeyVersion: 0,
            ...data,
        });
        const result: FolderSQL = await folderRepo.save(obj);
        // No explicit records — inherits from the mailbox's ACL via parentUid, same as
        // `BaseFolderRoute.create()`'s own seeding.
        await aclRepo.save({
            uid: result.uid,
            dateCreated: new Date(),
            dateModified: new Date(),
            version: 0,
            records: [],
            parentUid: mailboxUid,
        });
        return result;
    };

    const createContact = async function (mailboxUid: string, folderUid: string, data?: any): Promise<ContactSQL> {
        const obj: ContactSQL = new ContactSQL({
            mailboxUid,
            folderUid,
            displayName: "Jane Doe",
            emails: [{ address: "jane@example.com", type: ContactAddressKind.WORK }],
            phones: [],
            addresses: [],
            ...data,
        });
        return await contactRepo.save(obj);
        // Deliberately no ACL document created — Contact has `recordACL: false`; permission is checked
        // against the containing folder's ACL instead.
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
            mailboxRepo = conn.getRepository(MailboxSQL);
            folderRepo = conn.getRepository(FolderSQL);
            contactRepo = conn.getRepository(ContactSQL);
        } else {
            throw new Error("Could not find sql connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await contactRepo.clear();
        await folderRepo.clear();
        await mailboxRepo.clear();
    });

    it("Requires an explicit folderUid query parameter to list contacts.", async () => {
        const result = await request(server.getApplication())
            .get(baseUrl)
            .set("Authorization", "jwt " + ownerToken);
        expect(result.status).toBe(400);
    });

    it("Owner can list contacts in a folder they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        await createContact(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}?folderUid=${folder.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.body.length).toBe(1);
        expect(result.body[0].displayName).toBe("Jane Doe");
    });

    it("A different user cannot list contacts in a folder they don't have access to (silently empty).", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        await createContact(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}?folderUid=${folder.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(200);
        expect(result.body).toEqual([]);
    });

    it("Owner can create a contact in a folder they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send({
                mailboxUid: mailbox.uid,
                folderUid: folder.uid,
                displayName: "New Contact",
                emails: [],
                phones: [],
                addresses: [],
            });

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body.displayName).toBe("New Contact");

        // No per-record ACL should have been created for this contact (recordACL: false).
        const acl = await aclRepo.findOne({ where: { uid: result.body.uid } });
        expect(acl).toBeNull();
    });

    it("Rejects creating a contact with an explicit empty displayName (400) - proves model validation actually runs on create(), not just update(). BaseScopedChildRoute.create() never calls this.validate() itself; this is enforced by the framework's own dispatch-time @Validate metadata, which is inherited through every override in the chain (BaseContactRoute -> BaseScopedChildRoute -> CRUDRoute) even though none of them re-declare @Validate explicitly - confirmed by reading RouteDecorators.js's Reflect.getMetadata (chain-walking) usage.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send({
                mailboxUid: mailbox.uid,
                folderUid: folder.uid,
                displayName: "",
                emails: [],
                phones: [],
                addresses: [],
            });

        expect(result.status).toBe(400);
    });

    it("Rejects creating a contact that attempts to set a key-discovery-managed field directly (400).", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send({
                mailboxUid: mailbox.uid,
                folderUid: folder.uid,
                displayName: "New Contact",
                emails: [],
                phones: [],
                addresses: [],
                keys: [{ publicKey: "abc", type: "x509", useType: "encrypt", fingerprint: "fp", notBefore: 0, notAfter: 1 }],
            });

        expect(result.status).toBe(400);
    });

    it("A different user cannot create a contact in a folder they don't have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + otherUserToken)
            .send({
                mailboxUid: mailbox.uid,
                folderUid: folder.uid,
                displayName: "Intruder",
                emails: [],
                phones: [],
                addresses: [],
            });

        expect(result.status).toBe(403);
    });

    it("Owner can read a contact by id.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const contact = await createContact(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${contact.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.body.uid).toBe(contact.uid);
    });

    it("A different user cannot read a contact by id (404, not 403 — avoids existence leakage).", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const contact = await createContact(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${contact.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(404);
    });

    it("A different user gets 404 (not 200/1) checking existence of a contact they can't access.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const contact = await createContact(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .head(`${baseUrl}/${contact.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(404);
    });

    it("Owner can update a contact they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const contact = await createContact(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${contact.uid}`)
            .set("Authorization", "jwt " + ownerToken)
            .send({ uid: contact.uid, version: contact.version, displayName: "Renamed" });

        expect(result.status).toBe(200);
        expect(result.body.displayName).toBe("Renamed");
    });

    it("Lets the user choose a contact's preferred end-to-end format, or clear it, and refuses anything else (400).", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const contact = await createContact(mailbox.uid, folder.uid);
        const put = (version: number, preferredFormat: unknown) =>
            request(server.getApplication())
                .put(`${baseUrl}/${contact.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ uid: contact.uid, version, preferredFormat });

        const chosen = await put(contact.version, "openpgp");
        expect(chosen.status).toBe(200);
        expect(chosen.body.preferredFormat).toBe("openpgp");
        expect((await put(chosen.body.version, "pgp")).status).toBe(400);
        const cleared = await put(chosen.body.version, null);
        expect(cleared.status).toBe(200);
        expect(((await contactRepo.findOne({ where: { uid: contact.uid } })) as any)?.preferredFormat ?? undefined).toBeUndefined();
    });

    it("Rejects updating a contact that attempts to set a key-discovery-managed field directly (400), leaving it unchanged.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const contact = await createContact(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${contact.uid}`)
            .set("Authorization", "jwt " + ownerToken)
            .send({
                uid: contact.uid,
                version: contact.version,
                keyConflicts: [{ useType: "sign", observedKey: { fingerprint: "attacker-fp" }, observedAt: Date.now(), source: "header" }],
            });

        expect(result.status).toBe(400);
        for (const field of ["keyConflict", "previousKeys", "rejectedKeys", "observedFormat"]) {
            const refused = await request(server.getApplication())
                .put(`${baseUrl}/${contact.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ uid: contact.uid, version: contact.version, [field]: [] });
            expect(refused.status, field).toBe(400);
        }

        // SQL stores an unset nullable `simple-json` column as `null`, not `undefined` - see this codebase's
        // documented SQL null-vs-undefined gotcha (`resource_mailboxes_design` memory).
        const existing = await contactRepo.findOne({ where: { uid: contact.uid } });
        expect(existing?.keyConflicts).toBeFalsy();
    });

    it("A different user cannot update a contact they don't have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const contact = await createContact(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${contact.uid}`)
            .set("Authorization", "jwt " + otherUserToken)
            .send({ uid: contact.uid, version: contact.version, displayName: "Hijacked" });

        expect(result.status).toBe(403);
    });

    it("Owner cannot re-parent a contact into a folder they don't have access to (folderUid change is permission-checked against the NEW scope, not just the old one).", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const contact = await createContact(mailbox.uid, folder.uid);
        const otherMailbox = await createMailbox(otherUser.uid);
        const otherFolder = await createFolder(otherMailbox.uid);

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${contact.uid}`)
            .set("Authorization", "jwt " + ownerToken)
            .send({ uid: contact.uid, version: contact.version, folderUid: otherFolder.uid });

        expect(result.status).toBe(403);
        const existing = await contactRepo.findOne({ where: { uid: contact.uid } });
        expect(existing!.folderUid).toBe(folder.uid);
    });

    it("Owner can re-parent a contact into another folder of their own they DO have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const destinationFolder = await createFolder(mailbox.uid);
        const contact = await createContact(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${contact.uid}`)
            .set("Authorization", "jwt " + ownerToken)
            .send({ uid: contact.uid, version: contact.version, folderUid: destinationFolder.uid });

        expect(result.status).toBe(200);
        expect(result.body.folderUid).toBe(destinationFolder.uid);
    });

    // `ErasureExecutionJob` purges `Contact` by `mailboxUid` directly - see
    // `BaseScopedChildRoute.resolveMailboxUidFor()`'s own doc comment for why an independently
    // client-writable `mailboxUid` would let a contact silently escape a GDPR erasure scoped to a
    // mailbox it was never really in.
    it("Silently corrects a client-supplied mailboxUid on update() to the contact's real folder's mailbox, rather than trusting it.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const contact = await createContact(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${contact.uid}`)
            .set("Authorization", "jwt " + ownerToken)
            .send({ uid: contact.uid, version: contact.version, mailboxUid: "attacker-supplied-uid" });

        expect(result.status).toBe(200);
        expect(result.body.mailboxUid).toBe(mailbox.uid);
        const persisted = await contactRepo.findOne({ where: { uid: contact.uid } });
        expect(persisted!.mailboxUid).toBe(mailbox.uid);
    });

    it("Owner can delete a contact they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const contact = await createContact(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .delete(`${baseUrl}/${contact.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);

        // See the identical note in test/routes/mongo/ContactRoute.test.ts - `Contact` is now a
        // `RecoverableBaseEntity` (soft delete), so the raw row stays present with `deleted: true`.
        const existing = await contactRepo.findOne({ where: { uid: contact.uid } });
        expect(existing?.deleted).toBe(true);
    });

    it("Can make a count request scoped to a folder the caller has access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        await createContact(mailbox.uid, folder.uid);
        await createContact(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .head(`${baseUrl}?folderUid=${folder.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.headers["content-length"]).toBe("2");
    });

    it("A different user's count request for a folder they can't access returns 0.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        await createContact(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .head(`${baseUrl}?folderUid=${folder.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(200);
        expect(result.headers["content-length"]).toBe("0");
    });

    describe("zero-access encryption of contacts", () => {
        const protect = async (types: any) => {
            const mailbox: any = await createMailbox(owner.uid);
            const za = await testZeroAccessKey();
            mailbox.zeroAccessKeys = [za.key];
            mailbox.zeroAccessTypes = types;
            await mailboxRepo.save(mailbox);
            const folder = await createFolder(mailbox.uid);
            return { mailbox, folder, za };
        };
        const stored = async (uid: string): Promise<any> => await contactRepo.findOne({ where: { uid } });
        const CARD = {
            displayName: "CANARY Jane Doe",
            givenName: "CANARY-G",
            surname: "CANARY-S",
            company: "CANARY Corp",
            jobTitle: "CANARY Counsel",
            notes: "CANARY notes",
            categories: ["CANARY-cat"],
            emails: [{ address: "jane@example.com", type: "work" }],
            phones: [{ phoneNumber: "+1 555 0100", type: "work" }],
            addresses: [{ street: "CANARY 1 Main St", city: "Springfield", type: "home" }],
        };

        it("Seals everything but the email addresses, showing the first address as the name, and keeps the addresses readable", async () => {
            const { mailbox, folder, za } = await protect({ contacts: true });
            const result = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + ownerToken)
                .send({ mailboxUid: mailbox.uid, folderUid: folder.uid, ...CARD, sealedFields: { displayName: "forged" } });

            expect(result.status, JSON.stringify(result.body)).toBe(200);
            const row = await stored(result.body.uid);
            expect(row.displayName).toBe("jane@example.com");
            expect(row.emails).toEqual([{ address: "jane@example.com", type: "other" }]);
            expect(row.phones).toEqual([]);
            expect(row.company ?? null).toBeNull();
            expect(JSON.stringify(row)).not.toContain("CANARY");
            expect(await openSealedField(row.sealedFields.displayName, za)).toBe("CANARY Jane Doe");
            expect(await openSealedField(row.sealedFields.emails, za)).toEqual([{ address: "jane@example.com", type: "work" }]);
            expect(await openSealedField(row.sealedFields.addresses, za)).toEqual(CARD.addresses);

            // A partial update (the star) leaves every sealed field alone; the name sent back as shown is ignored.
            const starred = await request(server.getApplication())
                .put(`${baseUrl}/${row.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ uid: row.uid, version: result.body.version, favorite: true, displayName: "jane@example.com" });
            expect(starred.status, JSON.stringify(starred.body)).toBe(200);
            const after = await stored(row.uid);
            expect(after.favorite).toBe(true);
            expect(after.sealedFields).toEqual(row.sealedFields);
        });

        it("Stores a contact readable while contacts aren't protected", async () => {
            const { mailbox, folder } = await protect({ contacts: false });
            const result = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + ownerToken)
                .send({ mailboxUid: mailbox.uid, folderUid: folder.uid, ...CARD });
            expect(result.status).toBe(200);
            const row = await stored(result.body.uid);
            expect(row.displayName).toBe("CANARY Jane Doe");
            expect(row.sealedFields ?? null).toBeNull();
        });

        it("Clears a sealed field the client empties, and leaves the sealed fields it doesn't send alone", async () => {
            const { mailbox, folder, za } = await protect({ contacts: true });
            const created = (await request(server.getApplication()).post(baseUrl).set("Authorization", "jwt " + ownerToken).send({ mailboxUid: mailbox.uid, folderUid: folder.uid, ...CARD })).body;
            const cleared = await request(server.getApplication())
                .put(`${baseUrl}/${created.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ uid: created.uid, version: created.version, notes: null, phones: [], clearedFields: ["notes", "phones"] });
            expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
            const row = await stored(created.uid);
            expect(row.sealedFields.notes).toBeUndefined();
            expect(row.sealedFields.phones).toBeUndefined();
            expect(await openSealedField(row.sealedFields.company, za)).toBe("CANARY Corp");
        });

        it("Refuses moving a sealed contact to another mailbox (409), and seals one moved into a protected mailbox for that mailbox", async () => {
            const source = await protect({ contacts: true });
            const destination = await protect({ contacts: true });
            const put = (body: any) => request(server.getApplication()).put(`${baseUrl}/${body.uid}`).set("Authorization", "jwt " + ownerToken).send(body);
            const sealed = (await request(server.getApplication()).post(baseUrl).set("Authorization", "jwt " + ownerToken).send({ mailboxUid: source.mailbox.uid, folderUid: source.folder.uid, ...CARD })).body;
            const refused = await put({ uid: sealed.uid, version: sealed.version, folderUid: destination.folder.uid });
            expect(refused.status).toBe(409);
            expect((await stored(sealed.uid)).folderUid).toBe(source.folder.uid);

            const open = await protect({ contacts: false });
            const readable = (await request(server.getApplication()).post(baseUrl).set("Authorization", "jwt " + ownerToken).send({ mailboxUid: open.mailbox.uid, folderUid: open.folder.uid, ...CARD })).body;
            const moved = await put({ uid: readable.uid, version: readable.version, folderUid: destination.folder.uid, notes: "CANARY moved notes" });
            expect(moved.status, JSON.stringify(moved.body)).toBe(200);
            const row = await stored(readable.uid);
            expect(row.mailboxUid).toBe(destination.mailbox.uid);
            expect(row.notes ?? null).toBeNull();
            expect(await openSealedField(row.sealedFields.notes, destination.za)).toBe("CANARY moved notes");
            // What the move didn't carry is sealed for the destination too: nothing of it stays readable there.
            expect(JSON.stringify(row)).not.toContain("CANARY");
            expect(await openSealedField(row.sealedFields.company, destination.za)).toBe("CANARY Corp");
            expect(row.zeroAccessBackfillError ?? null).toBeNull();
        });

        it("Seals all of a contact on its first protected write, its readable photo included, and never wipes what a client that couldn't open it sends back", async () => {
            const { mailbox, folder, za } = await protect({ contacts: false });
            const put = (body: any) => request(server.getApplication()).put(`${baseUrl}/${body.uid}`).set("Authorization", "jwt " + ownerToken).send(body);
            const created = (await request(server.getApplication()).post(baseUrl).set("Authorization", "jwt " + ownerToken).send({ mailboxUid: mailbox.uid, folderUid: folder.uid, ...CARD })).body;
            const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
            const photoKey = `contact-photos/${created.uid}/readable`;
            await blobStore.put(photoKey, Buffer.from("CANARY-PHOTO"));
            await contactRepo.update({ uid: created.uid }, { photoBlobKey: photoKey });
            mailbox.zeroAccessTypes = { contacts: true };
            await mailboxRepo.save(mailbox);

            // A list's bulk categorize sends the categories alone, before the backfill reached the contact.
            const categorized = await put({ uid: created.uid, version: (await stored(created.uid)).version, categories: ["CANARY-new"] });
            expect(categorized.status, JSON.stringify(categorized.body)).toBe(200);
            const row = await stored(created.uid);
            expect(JSON.stringify(row)).not.toContain("CANARY");
            expect(Object.keys(row.sealedFields).sort()).toEqual(
                ["addresses", "categories", "company", "displayName", "emails", "givenName", "jobTitle", "notes", "phones", "surname"],
            );
            expect(await openSealedField(row.sealedFields.notes, za)).toBe("CANARY notes");
            expect(await openSealedField(row.sealedFields.categories, za)).toEqual(["CANARY-new"]);
            expect(row.photoSealed).toBe(true);
            expect(row.photoBlobKey).not.toBe(photoKey);
            expect(await blobStore.exists(photoKey)).toBe(false);
            expect((await blobStore.get(row.photoBlobKey)).toString("latin1")).not.toContain("CANARY");

            // A client that couldn't open it (keys locked, no key) sends its whole form back as shown: placeholders, nothing named cleared.
            const echoed = await put({
                uid: created.uid,
                version: row.version,
                displayName: row.displayName,
                givenName: null,
                surname: null,
                company: null,
                jobTitle: null,
                notes: null,
                phones: [],
                addresses: [],
                categories: [],
                emails: row.emails,
            });
            expect(echoed.status, JSON.stringify(echoed.body)).toBe(200);
            expect((await stored(created.uid)).sealedFields).toEqual(row.sealedFields);
        });
    });
});
