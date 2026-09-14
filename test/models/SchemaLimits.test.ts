///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { createHash } from "crypto";
import { ConnectionManager, ObjectFactory, PersistenceDecorators, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import config from "../config.sql.js";
import * as restapiSql from "../../src/models/sql/index.js";
import { Like, Raw, getMetadataArgsStorage } from "typeorm";
import { AttachmentSQL } from "../../src/models/sql/AttachmentSQL.js";
import { CalendarEventSQL } from "../../src/models/sql/CalendarEventSQL.js";
import { ContactSQL } from "../../src/models/sql/ContactSQL.js";
import { EscrowAuditLogEntrySQL } from "../../src/models/sql/EscrowAuditLogEntrySQL.js";
import { IngestQueueEntrySQL } from "../../src/models/sql/IngestQueueEntrySQL.js";
import { MessageSQL } from "../../src/models/sql/MessageSQL.js";
import { OofReplySuppressionSQL } from "../../src/models/sql/OofReplySuppressionSQL.js";
import { OofReplySuppressionMongo } from "../../src/models/mongo/OofReplySuppressionMongo.js";
import { boundIndexedValue } from "../../src/util/ConversationUtils.js";
import { TaskSQL } from "../../src/models/sql/TaskSQL.js";
import {
    applySqlDriverColumnTypes,
    ColumnArgsStorage,
    SIMPLE_JSON_LONGTEXT_TRANSFORMER,
} from "../../src/models/sql/SqlDriverColumnTypes.js";
import { CalendarEventMongo } from "../../src/models/mongo/CalendarEventMongo.js";
import { ContactMongo } from "../../src/models/mongo/ContactMongo.js";
import { MessageMongo } from "../../src/models/mongo/MessageMongo.js";
import { TaskMongo } from "../../src/models/mongo/TaskMongo.js";

const { Column, Entity, getColumnMetadata, getIndexMetadata } = PersistenceDecorators;

const sha256 = (value: string): string => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const columnType = (clazz: any, property: string): any => {
    const column = getColumnMetadata(clazz).find((c) => c.propertyName === property);
    return column?.options.type ?? column?.designType;
};
const indexColumns = (clazz: any): string[] => getIndexMetadata(clazz).map((index) => index.columns.join(","));

describe("Indexed identifier bounding", () => {
    const long: string = `<${"a".repeat(300)}@example.com>`;

    it.each([
        ["MessageSQL", MessageSQL],
        ["MessageMongo", MessageMongo],
    ])("%s stores an over-long messageId/conversationId as its SHA-256 and keeps normal values verbatim.", (_name, clazz: any) => {
        const bounded = new clazz({ messageId: long, conversationId: long });
        expect(bounded.messageId).toBe(sha256(long));
        expect(bounded.conversationId).toBe(sha256(long));
        expect(new clazz(bounded).messageId).toBe(sha256(long));

        const normal = new clazz({ messageId: "id@example.com", conversationId: "root@example.com" });
        expect(normal.messageId).toBe("id@example.com");
        expect(normal.conversationId).toBe("root@example.com");
        expect(new clazz({ conversationId: null }).conversationId).toBeNull();
        expect(new clazz({}).conversationId).toBeUndefined();
    });

    it.each([
        ["CalendarEventSQL", CalendarEventSQL],
        ["CalendarEventMongo", CalendarEventMongo],
    ])("%s stores an over-long icalUid as its SHA-256 and keeps normal values verbatim.", (_name, clazz: any) => {
        expect(new clazz({ icalUid: long }).icalUid).toBe(sha256(long));
        expect(new clazz({ icalUid: "uid-1" }).icalUid).toBe("uid-1");
    });

    it.each([
        ["OofReplySuppressionSQL", OofReplySuppressionSQL],
        ["OofReplySuppressionMongo", OofReplySuppressionMongo],
    ])("%s stores an over-long senderAddress as its SHA-256 and keeps normal values verbatim.", (_name, clazz: any) => {
        const address: string = `${"s".repeat(300)}@example.com`;
        expect(new clazz({ senderAddress: address }).senderAddress).toBe(sha256(address));
        expect(new clazz({ senderAddress: "a@example.com" }).senderAddress).toBe("a@example.com");
    });
});

describe("SQL column types for sender-controlled values", () => {
    it("Stores unindexed header-derived strings as text.", () => {
        expect(columnType(MessageSQL, "inReplyTo")).toBe("text");
        expect(columnType(MessageSQL, "dispositionNotificationTo")).toBe("text");
        expect(columnType(AttachmentSQL, "filename")).toBe("text");
        expect(columnType(AttachmentSQL, "contentId")).toBe("text");
        expect(columnType(IngestQueueEntrySQL, "envelopeFrom")).toBe("text");
        expect(columnType(AttachmentSQL, "mimeType")).toBe("text");
        expect(columnType(CalendarEventSQL, "timezone")).toBe("text");
    });

    it("Keeps the indexed identifiers as plain (indexable) string columns.", () => {
        expect(columnType(MessageSQL, "messageId")).toBe(String);
        expect(columnType(MessageSQL, "conversationId")).toBe(String);
        expect(columnType(CalendarEventSQL, "icalUid")).toBe(String);
        expect(columnType(OofReplySuppressionSQL, "senderAddress")).toBe(String);
    });
});

describe("Sync and conversation indexes", () => {
    it.each([
        ["MessageSQL", MessageSQL],
        ["MessageMongo", MessageMongo],
    ])("%s declares (mailboxUid, conversationId).", (_name, clazz: any) => {
        expect(indexColumns(clazz)).toContain("mailboxUid,conversationId");
    });

    it.each([
        ["MessageSQL", MessageSQL],
        ["MessageMongo", MessageMongo],
        ["CalendarEventSQL", CalendarEventSQL],
        ["CalendarEventMongo", CalendarEventMongo],
        ["ContactSQL", ContactSQL],
        ["ContactMongo", ContactMongo],
        ["TaskSQL", TaskSQL],
        ["TaskMongo", TaskMongo],
    ])("%s declares (folderUid, dateModified, uid) and (mailboxUid, dateModified, uid) exactly once.", (_name, clazz: any) => {
        const columns: string[] = indexColumns(clazz);
        expect(columns.filter((c) => c === "folderUid,dateModified,uid")).toHaveLength(1);
        expect(columns.filter((c) => c === "mailboxUid,dateModified,uid")).toHaveLength(1);
        const names: string[] = getIndexMetadata(clazz).map((index) => index.name!);
        expect(new Set(names).size).toBe(names.length);
    });
});

describe("applySqlDriverColumnTypes() Tests", () => {
    const find = (storage: ColumnArgsStorage, target: any, property: string): any =>
        storage.columns.find((c) => c.target === target && c.propertyName === property);

    it("Is a no-op for Postgres, SQLite and an unset driver type.", async () => {
        const storage: ColumnArgsStorage = { columns: [] };
        expect(await applySqlDriverColumnTypes("postgres", [MessageSQL], storage)).toBe(0);
        expect(await applySqlDriverColumnTypes("better-sqlite3", [MessageSQL], storage)).toBe(0);
        expect(await applySqlDriverColumnTypes(undefined, [MessageSQL], storage)).toBe(0);
        expect(await applySqlDriverColumnTypes("postgres")).toBe(0);
        expect(storage.columns).toHaveLength(0);
    });

    it.each(["mysql", "mariadb"])("On %s, widens text/simple-json to LONGTEXT and gives dates millisecond precision.", async (driver) => {
        const storage: ColumnArgsStorage = { columns: [] };
        const adjusted: number = await applySqlDriverColumnTypes(driver, [MessageSQL, EscrowAuditLogEntrySQL], storage);
        expect(adjusted).toBe(storage.columns.length);

        expect(find(storage, MessageSQL, "subject").options).toEqual({ type: "longtext" });
        expect(find(storage, MessageSQL, "inReplyTo").options).toEqual({ type: "longtext", nullable: true });
        expect(find(storage, MessageSQL, "recipients").options).toEqual({
            type: "longtext",
            transformer: SIMPLE_JSON_LONGTEXT_TRANSFORMER,
        });
        expect(find(storage, MessageSQL, "sentDate").options).toEqual({ type: Date, precision: 3 });
        expect(find(storage, MessageSQL, "searchIndexedAt").options).toEqual({ type: Date, precision: 3, nullable: true });
        // Inherited from the framework's base entity - registered against the leaf class.
        expect(find(storage, MessageSQL, "dateModified").options).toMatchObject({ type: Date, precision: 3 });
        expect(find(storage, EscrowAuditLogEntrySQL, "occurredAt").options).toEqual({ type: Date, precision: 3 });
        expect(find(storage, EscrowAuditLogEntrySQL, "details").options.type).toBe("longtext");

        // Untouched: indexed string, number and enum columns.
        expect(find(storage, MessageSQL, "messageId")).toBeUndefined();
        expect(find(storage, EscrowAuditLogEntrySQL, "sequence")).toBeUndefined();
        expect(find(storage, MessageSQL, "importance")).toBeUndefined();
    });

    it("Updates an existing registration in place and is idempotent.", async () => {
        const existing = { target: MessageSQL, propertyName: "subject", mode: "regular", options: { type: "text", name: "subj" } };
        const storage: ColumnArgsStorage = { columns: [existing] };
        await applySqlDriverColumnTypes("mysql", [MessageSQL], storage);
        const count: number = storage.columns.length;
        await applySqlDriverColumnTypes("mysql", [MessageSQL], storage);

        expect(storage.columns).toHaveLength(count);
        expect(storage.columns.filter((c) => c.propertyName === "subject")).toHaveLength(1);
        expect(existing.options).toEqual({ type: "longtext", name: "subj" });
    });

    it("Never registers a MongoDB ObjectId column, even one declared with a widenable type.", async () => {
        @Entity()
        class DriverTypesObjectIdEntity {
            @Column({ isObjectId: true, type: "text" })
            public _id?: any;

            @Column({ type: "text" })
            public note: string = "";
        }
        const storage: ColumnArgsStorage = { columns: [] };
        expect(await applySqlDriverColumnTypes("mysql", [DriverTypesObjectIdEntity], storage)).toBe(1);
        expect(find(storage, DriverTypesObjectIdEntity, "_id")).toBeUndefined();
        expect(find(storage, DriverTypesObjectIdEntity, "note").options).toEqual({ type: "longtext" });
    });

    it("Defaults to every restapi SQL model.", async () => {
        const storage: ColumnArgsStorage = { columns: [] };
        await applySqlDriverColumnTypes("mysql", undefined, storage);
        expect(find(storage, MessageSQL, "subject")).toBeDefined();
        expect(find(storage, CalendarEventSQL, "attendees")).toBeDefined();
        expect(find(storage, EscrowAuditLogEntrySQL, "occurredAt")).toBeDefined();
    });

    it("Wins over the framework's own base-class registration in TypeORM's real metadata storage.", async () => {
        class DriverTypesBase {
            @Column()
            public stamp: Date = new Date();
        }
        @Entity()
        class DriverTypesLeaf extends DriverTypesBase {
            @Column({ type: "simple-json", nullable: true })
            public data?: any;
        }
        const storage: any = getMetadataArgsStorage();
        // The framework's registration of the base-class column, as `registerFrameworkMetadata()` would add it.
        storage.columns.push({ target: DriverTypesBase, propertyName: "stamp", mode: "regular", options: { type: Date } });

        await applySqlDriverColumnTypes("mysql", [DriverTypesLeaf]);

        const resolved: any[] = storage.filterColumns([DriverTypesLeaf, DriverTypesBase]);
        expect(resolved.find((c: any) => c.propertyName === "stamp").options).toEqual({ type: Date, precision: 3 });
        expect(resolved.find((c: any) => c.propertyName === "data").options.type).toBe("longtext");
        // The shared base-class registration itself is left alone.
        expect(find(storage, DriverTypesBase, "stamp").options).toEqual({ type: Date });
    });

    it("SIMPLE_JSON_LONGTEXT_TRANSFORMER serializes like simple-json and passes query operators through.", () => {
        const value = { address: "a@example.com", list: [1, "two", null] };
        const stored: string = SIMPLE_JSON_LONGTEXT_TRANSFORMER.to(value);
        expect(stored).toBe(JSON.stringify(value));
        expect(SIMPLE_JSON_LONGTEXT_TRANSFORMER.from(stored)).toEqual(value);
        expect(SIMPLE_JSON_LONGTEXT_TRANSFORMER.to(null)).toBeNull();
        expect(SIMPLE_JSON_LONGTEXT_TRANSFORMER.to(undefined)).toBeUndefined();
        expect(SIMPLE_JSON_LONGTEXT_TRANSFORMER.from(null)).toBeNull();
        expect(SIMPLE_JSON_LONGTEXT_TRANSFORMER.from(value)).toBe(value);

        const raw = Raw((alias) => `${alias} LIKE :p`, { p: "%x%" });
        const like = Like("%x%");
        expect(SIMPLE_JSON_LONGTEXT_TRANSFORMER.to(raw)).toBe(raw);
        expect(SIMPLE_JSON_LONGTEXT_TRANSFORMER.to(like)).toBe(like);
    });
});

describe("SQL schema sync (better-sqlite3, every restapi SQL model)", () => {
    let objectFactory: ObjectFactory;
    let conn: any;

    beforeAll(async () => {
        objectFactory = new ObjectFactory(config, Logger());
        const connectionManager: ConnectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        for (const [name, value] of Object.entries(restapiSql)) {
            if (typeof value === "function" && Reflect.getMetadata("rrst:datasource", value) !== undefined) {
                models.set(name, value);
            }
        }
        await connectionManager.connect(
            { sql: { type: "better-sqlite3", host: "localhost", database: ":memory:", synchronize: true, invalidWhereValuesBehavior: { null: "sql-null" } } },
            models,
        );
        conn = connectionManager.connections.get("sql");
        if (!isSqlDataSource(conn)) {
            throw new Error("Could not find sql connection");
        }
    });

    afterAll(async () => {
        await objectFactory.destroy();
    });

    it("Creates the new compound indexes.", async () => {
        const queryRunner = conn.createQueryRunner();
        try {
            const indexNames = async (clazz: any): Promise<string[]> =>
                (await queryRunner.getTable(conn.getMetadata(clazz).tableName)).indices.map((index: any) => index.name);
            expect(await indexNames(MessageSQL)).toEqual(
                expect.arrayContaining(["message_mailbox_conversation", "message_folder_modified", "message_mailbox_modified"]),
            );
            expect(await indexNames(CalendarEventSQL)).toEqual(expect.arrayContaining(["calevent_folder_modified", "calevent_mailbox_modified"]));
            expect(await indexNames(ContactSQL)).toEqual(expect.arrayContaining(["contact_folder_modified", "contact_mailbox_modified"]));
            expect(await indexNames(TaskSQL)).toEqual(expect.arrayContaining(["task_folder_modified", "task_mailbox_modified"]));
        } finally {
            await queryRunner.release();
        }
    });

    it("Round-trips a message with over-long header values, found again by its bounded messageId.", async () => {
        const repo = conn.getRepository(MessageSQL);
        const longId: string = `${"m".repeat(1000)}@example.com`;
        const longHeader: string = `${"h".repeat(2000)}@example.com`;
        await repo.save(
            new MessageSQL({
                folderUid: "f1",
                mailboxUid: "mbx1",
                messageId: longId,
                conversationId: longId,
                inReplyTo: longHeader,
                dispositionNotificationTo: longHeader,
                bodyBlobKey: "k1",
            }),
        );
        const found: MessageSQL[] = await repo.find({ where: { mailboxUid: "mbx1", messageId: boundIndexedValue(longId) } });
        expect(found).toHaveLength(1);
        expect(found[0].inReplyTo).toBe(longHeader);
        expect(found[0].dispositionNotificationTo).toBe(longHeader);
        expect(found[0].conversationId).toBe(boundIndexedValue(longId));
    });
});
