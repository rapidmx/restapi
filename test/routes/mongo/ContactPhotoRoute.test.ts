///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.js";
import { request } from "@rapidrest/service-core/test";
import {
    MongoConnection,
    MongoRepository,
    Server,
    ObjectFactory,
    ConnectionManager,
    ACLAction,
    NotificationUtils,
} from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { FolderMongo } from "../../../src/models/mongo/FolderMongo.js";
import { ContactMongo } from "../../../src/models/mongo/ContactMongo.js";
import { ContactAddressKind, FolderType } from "../../../src/models/types.js";
import { CONTACT_PHOTO_MAX_BYTES } from "../../../src/routes/BaseContactRoute.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles, InMemoryBlobStore } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        port: 9999,
        dbName: "rrst-test",
    },
});

const JPEG: Buffer = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg-bytes")]);
const PNG: Buffer = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png-bytes")]);
const GIF: Buffer = Buffer.from("GIF89a-gif-bytes");
const WEBP: Buffer = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBPVP8 ")]);
const SVG: Buffer = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

describe("Route:ContactPhotoMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const baseUrl = "/mongo/contacts";
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let folderRepo: MongoRepository<FolderMongo>;
    let contactRepo: MongoRepository<ContactMongo>;
    let aclRepo: MongoRepository<any>;
    let blobStore: InMemoryBlobStore;

    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const ownerToken = JWTUtils.createTokenSync(config.get("auth"), owner);
    const otherUser: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const otherUserToken = JWTUtils.createTokenSync(config.get("auth"), otherUser);

    const createMailbox = async function (ownerUid: string): Promise<MailboxMongo> {
        const obj: MailboxMongo = new MailboxMongo({
            ownerUserUid: ownerUid,
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "Test Mailbox",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
        });
        const result: MailboxMongo = await mailboxRepo.save(obj);
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

    const createFolder = async function (mailboxUid: string): Promise<FolderMongo> {
        const result: FolderMongo = await folderRepo.save(
            new FolderMongo({
                mailboxUid,
                name: "Contacts",
                type: FolderType.CONTACTS,
                unreadCount: 0,
                totalCount: 0,
                syncKeyVersion: 0,
            }),
        );
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

    const createContact = async function (mailboxUid: string, folderUid: string, data?: any): Promise<ContactMongo> {
        return await contactRepo.save(
            new ContactMongo({
                mailboxUid,
                folderUid,
                displayName: "Jane Doe",
                emails: [{ address: "jane@example.com", type: ContactAddressKind.WORK }],
                phones: [],
                addresses: [],
                ...data,
            }),
        );
    };

    /** Grants `otherUser` `actions` on the mailbox (its folders inherit). */
    const grantOtherUser = async function (mailboxUid: string, actions: string[]): Promise<void> {
        await aclRepo.updateOne({ uid: mailboxUid } as any, { $push: { records: { userOrRoleId: otherUser.uid, actions } } } as any);
    };

    /** Gives the contact a stored photo without going through the route. */
    const seedPhoto = async function (contactUid: string, bytes: Buffer): Promise<string> {
        const key = `contact-photos/${contactUid}/${uuid.v4()}`;
        await blobStore.put(key, bytes);
        await contactRepo.updateOne({ uid: contactUid } as any, { $set: { photoBlobKey: key } } as any);
        return key;
    };

    const putPhoto = (contactUid: string, body: Buffer, contentType: string | null = "image/jpeg", token: string = ownerToken, query: string = "") => {
        let req = request(server.getApplication())
            .put(`${baseUrl}/${contactUid}/photo${query}`)
            .set("Authorization", "jwt " + token);
        if (contentType) {
            req = req.set("Content-Type", contentType);
        }
        return req.send(body);
    };

    const getPhoto = (contactUid: string, token: string = ownerToken) =>
        request(server.getApplication())
            .get(`${baseUrl}/${contactUid}/photo`)
            .set("Authorization", "jwt " + token);

    const deletePhoto = (contactUid: string, token: string = ownerToken, query: string = "") =>
        request(server.getApplication())
            .delete(`${baseUrl}/${contactUid}/photo${query}`)
            .set("Authorization", "jwt " + token);

    /** A mailbox, folder and contact owned by `owner`. */
    const setup = async function (data?: any) {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const contact = await createContact(mailbox.uid, folder.uid, data);
        return { mailbox, folder, contact };
    };

    beforeAll(async () => {
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        let conn: any = connMgr?.connections.get("acl");
        if (conn instanceof MongoConnection) {
            aclRepo = conn.getMongoRepository("AccessControlListMongo");
        }
        conn = connMgr?.connections.get("mongo");
        if (conn instanceof MongoConnection) {
            mailboxRepo = conn.getMongoRepository("MailboxMongo");
            folderRepo = conn.getMongoRepository("FolderMongo");
            contactRepo = conn.getMongoRepository("ContactMongo");
        } else {
            throw new Error("Could not find mongo connection");
        }
        blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
    });

    afterAll(async () => {
        await server.stop();
        await mongod.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        for (const repo of [mailboxRepo, folderRepo, contactRepo]) {
            try {
                await repo.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
    });

    it("Owner can set a contact's photo: the bytes are stored under a fresh contact-photos key, the version bumps and the updated contact is returned.", async () => {
        const { contact } = await setup();

        const result = await putPhoto(contact.uid, JPEG);

        expect(result.status).toBe(200);
        expect(result.body.uid).toBe(contact.uid);
        expect(result.body.displayName).toBe("Jane Doe");
        expect(result.body.version).toBe(contact.version + 1);
        expect(result.body.photoBlobKey).toMatch(new RegExp(`^contact-photos/${contact.uid}/[0-9a-f-]{36}$`));
        expect((await blobStore.get(result.body.photoBlobKey)).equals(JPEG)).toBe(true);
        const persisted = await contactRepo.findOne({ uid: contact.uid } as any);
        expect(persisted!.photoBlobKey).toBe(result.body.photoBlobKey);
    });

    it.each([
        ["image/jpeg", JPEG],
        ["image/png", PNG],
        ["image/gif", GIF],
        ["image/webp", WEBP],
    ])("Accepts a %s photo and serves it back with that type.", async (contentType, bytes) => {
        const { contact } = await setup();

        expect((await putPhoto(contact.uid, bytes, contentType)).status).toBe(200);
        const result = await getPhoto(contact.uid);

        expect(result.status).toBe(200);
        expect(result.headers["content-type"]).toBe(contentType);
        // (The test client decodes bodies as text, so the exact bytes are checked in the blob store and by length here.)
        expect(result.headers["content-length"]).toBe(String(bytes.length));
        expect((await blobStore.get((await contactRepo.findOne({ uid: contact.uid } as any))!.photoBlobKey!)).equals(bytes)).toBe(true);
    });

    it("Accepts a Content-Type with parameters and different case.", async () => {
        const { contact } = await setup();

        expect((await putPhoto(contact.uid, PNG, "Image/PNG; charset=binary")).status).toBe(200);
    });

    it("Rejects an SVG, another type, or a missing Content-Type with 415, storing nothing.", async () => {
        const { contact } = await setup();
        const putSpy = vi.spyOn(blobStore, "put");

        for (const [contentType, body] of [
            ["image/svg+xml", SVG],
            ["image/avif", PNG],
            ["application/octet-stream", JPEG],
            ["text/plain", Buffer.from("hello")],
            [null, JPEG],
        ] as [string | null, Buffer][]) {
            const result = await putPhoto(contact.uid, body, contentType);
            expect(result.status, String(contentType)).toBe(415);
            expect(result.body.message ?? JSON.stringify(result.body)).toContain("image/jpeg");
        }

        expect(putSpy).not.toHaveBeenCalled();
        const persisted = await contactRepo.findOne({ uid: contact.uid } as any);
        expect(persisted!.photoBlobKey).toBeUndefined();
    });

    it("Rejects a body whose magic bytes do not match the declared type with 400 (spoofed Content-Type).", async () => {
        const { contact } = await setup();
        const putSpy = vi.spyOn(blobStore, "put");

        for (const [contentType, body] of [
            ["image/png", SVG],
            ["image/png", JPEG],
            ["image/jpeg", PNG],
            ["image/gif", WEBP],
            ["image/webp", GIF],
            ["image/jpeg", Buffer.from("not an image at all")],
        ] as [string, Buffer][]) {
            const result = await putPhoto(contact.uid, body, contentType);
            expect(result.status, `${contentType} ${body.subarray(0, 8).toString("hex")}`).toBe(400);
            expect(result.body.message ?? JSON.stringify(result.body)).toContain(`not a valid ${contentType} image`);
        }

        expect(putSpy).not.toHaveBeenCalled();
    });

    it("Rejects a body that is really an AVIF or another unsupported image, whatever it is declared as.", async () => {
        const { contact } = await setup();
        const avif = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypavif"), Buffer.alloc(16)]);

        expect((await putPhoto(contact.uid, avif, "image/png")).status).toBe(400);
    });

    it("Rejects an empty body with 400.", async () => {
        const { contact } = await setup();

        const result = await putPhoto(contact.uid, Buffer.alloc(0));

        expect(result.status).toBe(400);
    });

    it("Rejects a photo above the size limit with 413, and accepts one of exactly the limit.", async () => {
        const { contact } = await setup();
        const putSpy = vi.spyOn(blobStore, "put");

        const tooBig = Buffer.concat([JPEG, Buffer.alloc(CONTACT_PHOTO_MAX_BYTES - JPEG.length + 1)]);
        const refused = await putPhoto(contact.uid, tooBig);
        expect(refused.status).toBe(413);
        expect(putSpy).not.toHaveBeenCalled();

        const exact = Buffer.concat([JPEG, Buffer.alloc(CONTACT_PHOTO_MAX_BYTES - JPEG.length)]);
        expect(exact.length).toBe(CONTACT_PHOTO_MAX_BYTES);
        expect((await putPhoto(contact.uid, exact)).status).toBe(200);
    });

    it("A different user cannot set the photo of a contact they have no access to (403), and nothing is stored.", async () => {
        const { contact } = await setup();
        const putSpy = vi.spyOn(blobStore, "put");

        const result = await putPhoto(contact.uid, JPEG, "image/jpeg", otherUserToken);

        expect(result.status).toBe(403);
        expect(putSpy).not.toHaveBeenCalled();
    });

    it("A caller with a read-only grant on a shared mailbox cannot set or remove the photo (403) but can read it.", async () => {
        const { mailbox, contact } = await setup();
        await seedPhoto(contact.uid, PNG);
        await grantOtherUser(mailbox.uid, [ACLAction.READ, ACLAction.LIST]);

        expect((await putPhoto(contact.uid, JPEG, "image/jpeg", otherUserToken)).status).toBe(403);
        expect((await deletePhoto(contact.uid, otherUserToken)).status).toBe(403);
        const read = await getPhoto(contact.uid, otherUserToken);
        expect(read.status).toBe(200);
        expect(read.headers["content-length"]).toBe(String(PNG.length));
    });

    it("A delegate with UPDATE access can set the photo.", async () => {
        const { mailbox, contact } = await setup();
        await grantOtherUser(mailbox.uid, [ACLAction.READ, ACLAction.UPDATE]);

        expect((await putPhoto(contact.uid, JPEG, "image/jpeg", otherUserToken)).status).toBe(200);
    });

    it("Setting the photo of a nonexistent contact is 404.", async () => {
        expect((await putPhoto(uuid.v4(), JPEG)).status).toBe(404);
    });

    it("A soft-deleted contact has no photo endpoints (404), but keeps its photo.", async () => {
        const { contact } = await setup();
        const key = (await putPhoto(contact.uid, JPEG)).body.photoBlobKey;
        expect((await request(server.getApplication()).delete(`${baseUrl}/${contact.uid}`).set("Authorization", "jwt " + ownerToken)).status).toBeLessThan(300);

        expect((await putPhoto(contact.uid, PNG, "image/png")).status).toBe(404);
        expect((await getPhoto(contact.uid)).status).toBe(404);
        expect((await deletePhoto(contact.uid)).status).toBe(404);
        expect(await blobStore.exists(key)).toBe(true);
    });

    it("Publishes the same live-update notification as a normal contact update, to the folder's channel.", async () => {
        const { folder, contact } = await setup();
        const sendMessageSpy = vi.spyOn(NotificationUtils.prototype, "sendMessage");

        await putPhoto(contact.uid, JPEG);
        expect(sendMessageSpy).toHaveBeenCalledWith(
            folder.uid,
            "ContactMongo",
            "update",
            expect.objectContaining({ uid: contact.uid, photoBlobKey: expect.stringContaining("contact-photos/") }),
        );

        sendMessageSpy.mockClear();
        await deletePhoto(contact.uid);
        expect(sendMessageSpy).toHaveBeenCalledWith(folder.uid, "ContactMongo", "update", expect.objectContaining({ uid: contact.uid }));
        sendMessageSpy.mockRestore();
    });

    it("Replacing the photo deletes the previous blob and keeps the new one.", async () => {
        const { contact } = await setup();
        const first = (await putPhoto(contact.uid, JPEG)).body;

        const second = await putPhoto(contact.uid, PNG, "image/png");

        expect(second.status).toBe(200);
        expect(second.body.photoBlobKey).not.toBe(first.photoBlobKey);
        expect(second.body.version).toBe(first.version + 1);
        expect(await blobStore.exists(first.photoBlobKey)).toBe(false);
        expect(await blobStore.exists(second.body.photoBlobKey)).toBe(true);
    });

    it("Keeps a previous blob that another contact row still references.", async () => {
        const { mailbox, folder, contact } = await setup();
        const first = (await putPhoto(contact.uid, JPEG)).body;
        await createContact(mailbox.uid, folder.uid, { photoBlobKey: first.photoBlobKey });

        expect((await putPhoto(contact.uid, PNG, "image/png")).status).toBe(200);

        expect(await blobStore.exists(first.photoBlobKey)).toBe(true);
    });

    it("Never deletes a previous photoBlobKey that is not a contact-photos key (a trusted caller stored some other blob).", async () => {
        const foreign = `attachments/${uuid.v4()}`;
        await blobStore.put(foreign, Buffer.from("someone else's attachment"));
        const { contact } = await setup({ photoBlobKey: foreign });

        const result = await putPhoto(contact.uid, JPEG);

        expect(result.status).toBe(200);
        expect(result.body.photoBlobKey).not.toBe(foreign);
        expect(await blobStore.exists(foreign)).toBe(true);
    });

    it("Honors an optional ?version=: the current version succeeds.", async () => {
        const { contact } = await setup();

        const result = await putPhoto(contact.uid, JPEG, "image/jpeg", ownerToken, `?version=${contact.version}`);

        expect(result.status).toBe(200);
    });

    it("Answers a stale ?version= with 409, leaving the contact unchanged and no blob behind.", async () => {
        const { contact } = await setup();
        const putSpy = vi.spyOn(blobStore, "put");

        const result = await putPhoto(contact.uid, JPEG, "image/jpeg", ownerToken, `?version=${contact.version + 5}`);

        expect(result.status).toBe(409);
        const persisted = await contactRepo.findOne({ uid: contact.uid } as any);
        expect(persisted!.photoBlobKey).toBeUndefined();
        expect(persisted!.version).toBe(contact.version);
        // The blob was stored (the version is checked against the row it replaces) and then removed again.
        for (const call of putSpy.mock.calls) {
            expect(await blobStore.exists(call[0])).toBe(false);
        }
    });

    it("Rejects a malformed ?version= with 400.", async () => {
        const { contact } = await setup();

        expect((await putPhoto(contact.uid, JPEG, "image/jpeg", ownerToken, "?version=abc")).status).toBe(400);
        expect((await deletePhoto(contact.uid, ownerToken, "?version=-1")).status).toBe(400);
    });

    it("A store failure stores no photo and fails the request.", async () => {
        const { contact } = await setup();
        vi.spyOn(blobStore, "put").mockRejectedValueOnce(new Error("simulated blob store failure"));

        const result = await putPhoto(contact.uid, JPEG);

        expect(result.status).toBe(500);
        const persisted = await contactRepo.findOne({ uid: contact.uid } as any);
        expect(persisted!.photoBlobKey).toBeUndefined();
    });

    it("A client cannot set photoBlobKey through an ordinary contact update.", async () => {
        const { contact } = await setup();

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${contact.uid}`)
            .set("Authorization", "jwt " + ownerToken)
            .send({ uid: contact.uid, version: contact.version, displayName: "Renamed", photoBlobKey: "attachments/steal-me" });

        expect(result.status).toBe(200);
        expect(result.body.photoBlobKey).toBeUndefined();
    });

    it("GET returns the stored bytes with safe headers, an ETag and a private, always-revalidated cache.", async () => {
        const { contact } = await setup();
        const key = (await putPhoto(contact.uid, PNG, "image/png")).body.photoBlobKey;

        const result = await getPhoto(contact.uid);

        expect(result.status).toBe(200);
        expect(result.headers["content-type"]).toBe("image/png");
        expect(result.headers["content-length"]).toBe(String(PNG.length));
        expect(result.headers["cache-control"]).toBe("private, no-cache");
        expect(result.headers["etag"]).toBe(`"${key.substring(key.lastIndexOf("/") + 1)}"`);
        expect(result.headers["x-content-type-options"]).toBe("nosniff");
        expect(result.headers["content-disposition"]).toBe("inline");
        expect(result.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    });

    it("GET with a matching If-None-Match is 304 with no body; a stale one gets the image; a new upload changes the ETag.", async () => {
        const { contact } = await setup();
        await putPhoto(contact.uid, JPEG);
        const etag = (await getPhoto(contact.uid)).headers["etag"];
        const conditional = (value: string) =>
            request(server.getApplication())
                .get(`${baseUrl}/${contact.uid}/photo`)
                .set("Authorization", "jwt " + ownerToken)
                .set("If-None-Match", value);

        for (const value of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
            const result = await conditional(value);
            expect(result.status, value).toBe(304);
            expect(result.headers["etag"]).toBe(etag);
            expect(result.headers["cache-control"]).toBe("private, no-cache");
        }
        expect((await conditional('"stale"')).status).toBe(200);

        await putPhoto(contact.uid, PNG, "image/png");
        expect((await conditional(etag)).status).toBe(200);
    });

    it("GET is 404 for a contact with no photo, a nonexistent contact, and a caller who cannot read the contact.", async () => {
        const { contact } = await setup();
        expect((await getPhoto(contact.uid)).status).toBe(404);
        expect((await getPhoto(uuid.v4())).status).toBe(404);

        await putPhoto(contact.uid, JPEG);
        const denied = await getPhoto(contact.uid, otherUserToken);
        expect(denied.status).toBe(404);
        expect((await getPhoto(contact.uid, otherUserToken)).body).toEqual((await getPhoto(uuid.v4(), otherUserToken)).body);
        const unauthenticated = await request(server.getApplication()).get(`${baseUrl}/${contact.uid}/photo`);
        expect(unauthenticated.status).toBeGreaterThanOrEqual(400);
    });

    it("GET never serves a photoBlobKey outside the contact's own contact-photos prefix.", async () => {
        const foreign = `attachments/${uuid.v4()}`;
        await blobStore.put(foreign, JPEG);
        const { mailbox, folder, contact } = await setup({ photoBlobKey: foreign });
        const otherContactKey = `contact-photos/${uuid.v4()}/${uuid.v4()}`;
        await blobStore.put(otherContactKey, JPEG);
        const other = await createContact(mailbox.uid, folder.uid, { photoBlobKey: otherContactKey });

        expect((await getPhoto(contact.uid)).status).toBe(404);
        expect((await getPhoto(other.uid)).status).toBe(404);
    });

    it("DELETE clears the photo, deletes its blob, bumps the version and returns the updated contact.", async () => {
        const { contact } = await setup();
        const uploaded = (await putPhoto(contact.uid, JPEG)).body;

        const result = await deletePhoto(contact.uid);

        expect(result.status).toBe(200);
        expect(result.body.uid).toBe(contact.uid);
        expect(result.body.photoBlobKey).toBeFalsy();
        expect(result.body.version).toBe(uploaded.version + 1);
        expect(await blobStore.exists(uploaded.photoBlobKey)).toBe(false);
        expect((await getPhoto(contact.uid)).status).toBe(404);
    });

    it("DELETE is idempotent: a contact with no photo is returned unchanged, without a version bump or notification.", async () => {
        const { contact } = await setup();
        const sendMessageSpy = vi.spyOn(NotificationUtils.prototype, "sendMessage");

        const result = await deletePhoto(contact.uid);

        expect(result.status).toBe(200);
        expect(result.body.uid).toBe(contact.uid);
        expect(result.body.version).toBe(contact.version);
        expect(sendMessageSpy).not.toHaveBeenCalled();
        sendMessageSpy.mockRestore();

        const again = await deletePhoto(contact.uid);
        expect(again.status).toBe(200);
        expect(again.body.version).toBe(contact.version);
    });

    it("DELETE honors ?version= (409 when stale) and access rules (403 without UPDATE, 404 for no contact).", async () => {
        const { contact } = await setup();
        const uploaded = (await putPhoto(contact.uid, JPEG)).body;

        expect((await deletePhoto(contact.uid, ownerToken, `?version=${uploaded.version + 3}`)).status).toBe(409);
        expect((await deletePhoto(contact.uid, otherUserToken)).status).toBe(403);
        expect((await deletePhoto(uuid.v4())).status).toBe(404);
        expect(await blobStore.exists(uploaded.photoBlobKey)).toBe(true);

        expect((await deletePhoto(contact.uid, ownerToken, `?version=${uploaded.version}`)).status).toBe(200);
    });

    it("Permanently deleting a contact (?purge=true) deletes its photo blob.", async () => {
        const { contact } = await setup();
        const key = (await putPhoto(contact.uid, JPEG)).body.photoBlobKey;

        const result = await request(server.getApplication())
            .delete(`${baseUrl}/${contact.uid}?purge=true`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeLessThan(300);
        expect(await contactRepo.findOne({ uid: contact.uid } as any)).toBeNull();
        expect(await blobStore.exists(key)).toBe(false);
    });

    it("Soft-deleting a contact keeps its photo blob (the contact is recoverable).", async () => {
        const { contact } = await setup();
        const key = (await putPhoto(contact.uid, JPEG)).body.photoBlobKey;

        await request(server.getApplication()).delete(`${baseUrl}/${contact.uid}`).set("Authorization", "jwt " + ownerToken);

        expect(await blobStore.exists(key)).toBe(true);
    });

    it("Truncating a folder deletes the photo blobs of its contacts, and leaves other folders' alone.", async () => {
        const { mailbox, folder, contact } = await setup();
        const second = await createContact(mailbox.uid, folder.uid, { displayName: "Second" });
        const otherFolder = await createFolder(mailbox.uid);
        const elsewhere = await createContact(mailbox.uid, otherFolder.uid, { displayName: "Elsewhere" });
        const keys: string[] = [];
        for (const c of [contact, second, elsewhere]) {
            keys.push((await putPhoto(c.uid, JPEG)).body.photoBlobKey);
        }
        // A contact without a photo takes no part.
        await createContact(mailbox.uid, folder.uid, { displayName: "No photo" });

        const result = await request(server.getApplication())
            .delete(`${baseUrl}?folderUid=${folder.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeLessThan(300);
        expect(await blobStore.exists(keys[0])).toBe(false);
        expect(await blobStore.exists(keys[1])).toBe(false);
        expect(await blobStore.exists(keys[2])).toBe(true);
    });
});
