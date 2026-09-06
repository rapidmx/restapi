///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    AttendeeResponseStatus,
    AttendeeRole,
    AvVerdict,
    BusyStatus,
    CalendarEventStatus,
    ContactAddressKind,
    FolderType,
    IngestStatus,
    MessageImportance,
    QuarantineReason,
    RecipientType,
    RecurrenceFrequency,
    ScanTargetType,
    SpamVerdict,
    TaskPriority,
} from "../../src/models/types.js";
import { AttachmentMongo } from "../../src/models/mongo/AttachmentMongo.js";
import { CalendarEventMongo } from "../../src/models/mongo/CalendarEventMongo.js";
import { CalendarShareLinkMongo } from "../../src/models/mongo/CalendarShareLinkMongo.js";
import { ContactMongo } from "../../src/models/mongo/ContactMongo.js";
import { ContactListMongo } from "../../src/models/mongo/ContactListMongo.js";
import { DeviceSyncStateMongo } from "../../src/models/mongo/DeviceSyncStateMongo.js";
import { FolderMongo } from "../../src/models/mongo/FolderMongo.js";
import { IngestQueueEntryMongo } from "../../src/models/mongo/IngestQueueEntryMongo.js";
import { MailboxMongo } from "../../src/models/mongo/MailboxMongo.js";
import { MessageMongo } from "../../src/models/mongo/MessageMongo.js";
import { NoteMongo } from "../../src/models/mongo/NoteMongo.js";
import { QuarantineEntryMongo } from "../../src/models/mongo/QuarantineEntryMongo.js";
import { ScanResultMongo } from "../../src/models/mongo/ScanResultMongo.js";
import { SearchIndexStateMongo } from "../../src/models/mongo/SearchIndexStateMongo.js";
import { TaskMongo } from "../../src/models/mongo/TaskMongo.js";

describe("Mongo model default construction", () => {
    it("MailboxMongo falls back to class defaults when constructed with no data.", () => {
        const obj = new MailboxMongo();

        expect(obj.ownerUserUid).toBeUndefined();
        expect(obj.primarySmtpAddress).toBe("");
        expect(obj.aliasAddresses).toEqual([]);
        expect(obj.displayName).toBe("");
        expect(obj.timezone).toBe("");
        expect(obj.quotaBytes).toBe(0);
        expect(obj.usedBytes).toBe(0);
    });

    it("MailboxMongo applies provided overrides when constructed with data.", () => {
        const obj = new MailboxMongo({
            ownerUserUid: "user-1",
            primarySmtpAddress: "user@example.com",
            aliasAddresses: ["alias@example.com"],
            displayName: "Example User",
            timezone: "America/Los_Angeles",
            quotaBytes: 1000,
            usedBytes: 500,
        });

        expect(obj.ownerUserUid).toBe("user-1");
        expect(obj.primarySmtpAddress).toBe("user@example.com");
        expect(obj.aliasAddresses).toEqual(["alias@example.com"]);
        expect(obj.displayName).toBe("Example User");
        expect(obj.timezone).toBe("America/Los_Angeles");
        expect(obj.quotaBytes).toBe(1000);
        expect(obj.usedBytes).toBe(500);
    });

    it("FolderMongo falls back to class defaults when constructed with no data.", () => {
        const obj = new FolderMongo();

        expect(obj.mailboxUid).toBe("");
        expect(obj.name).toBe("");
        expect(obj.type).toBe(FolderType.USER);
        expect(obj.parentFolderUid).toBeUndefined();
        expect(obj.unreadCount).toBe(0);
        expect(obj.totalCount).toBe(0);
        expect(obj.syncKeyVersion).toBe(0);
    });

    it("FolderMongo applies provided overrides when constructed with data.", () => {
        const obj = new FolderMongo({
            mailboxUid: "mailbox-1",
            name: "My Folder",
            type: FolderType.INBOX,
            parentFolderUid: "folder-parent",
            unreadCount: 5,
            totalCount: 10,
            syncKeyVersion: 3,
        });

        expect(obj.mailboxUid).toBe("mailbox-1");
        expect(obj.name).toBe("My Folder");
        expect(obj.type).toBe(FolderType.INBOX);
        expect(obj.parentFolderUid).toBe("folder-parent");
        expect(obj.unreadCount).toBe(5);
        expect(obj.totalCount).toBe(10);
        expect(obj.syncKeyVersion).toBe(3);
    });

    it("MessageMongo falls back to class defaults when constructed with no data.", () => {
        const obj = new MessageMongo();

        expect(obj.folderUid).toBe("");
        expect(obj.mailboxUid).toBe("");
        expect(obj.messageId).toBe("");
        expect(obj.subject).toBe("");
        expect(obj.from).toEqual({ address: "", type: RecipientType.TO });
        expect(obj.recipients).toEqual([]);
        expect(obj.sentDate).toBeInstanceOf(Date);
        expect(obj.receivedDate).toBeInstanceOf(Date);
        expect(obj.bodyBlobKey).toBe("");
        expect(obj.bodyPreview).toBe("");
        expect(obj.flags).toEqual({ read: false, flagged: false, answered: false, forwarded: false });
        expect(obj.importance).toBe(MessageImportance.NORMAL);
        expect(obj.inReplyTo).toBeUndefined();
        expect(obj.references).toEqual([]);
        expect(obj.hasAttachments).toBe(false);
        expect(obj.scanResultUid).toBeUndefined();
        expect(obj.searchIndexedAt).toBeUndefined();
    });

    it("MessageMongo applies provided overrides when constructed with data.", () => {
        const sentDate = new Date("2026-01-01T00:00:00Z");
        const receivedDate = new Date("2026-01-01T00:01:00Z");
        const searchIndexedAt = new Date("2026-01-02T00:00:00Z");
        const obj = new MessageMongo({
            folderUid: "folder-1",
            mailboxUid: "mailbox-1",
            messageId: "<abc@example.com>",
            subject: "Hello",
            from: { address: "from@example.com", type: RecipientType.TO },
            recipients: [{ address: "to@example.com", type: RecipientType.TO }],
            sentDate,
            receivedDate,
            bodyBlobKey: "blob-1",
            bodyPreview: "preview text",
            flags: { read: true, flagged: true, answered: true, forwarded: true },
            importance: MessageImportance.HIGH,
            inReplyTo: "<parent@example.com>",
            references: ["<ref1@example.com>"],
            hasAttachments: true,
            scanResultUid: "scan-1",
            searchIndexedAt,
        });

        expect(obj.folderUid).toBe("folder-1");
        expect(obj.mailboxUid).toBe("mailbox-1");
        expect(obj.messageId).toBe("<abc@example.com>");
        expect(obj.subject).toBe("Hello");
        expect(obj.from).toEqual({ address: "from@example.com", type: RecipientType.TO });
        expect(obj.recipients).toEqual([{ address: "to@example.com", type: RecipientType.TO }]);
        expect(obj.sentDate).toBe(sentDate);
        expect(obj.receivedDate).toBe(receivedDate);
        expect(obj.bodyBlobKey).toBe("blob-1");
        expect(obj.bodyPreview).toBe("preview text");
        expect(obj.flags).toEqual({ read: true, flagged: true, answered: true, forwarded: true });
        expect(obj.importance).toBe(MessageImportance.HIGH);
        expect(obj.inReplyTo).toBe("<parent@example.com>");
        expect(obj.references).toEqual(["<ref1@example.com>"]);
        expect(obj.hasAttachments).toBe(true);
        expect(obj.scanResultUid).toBe("scan-1");
        expect(obj.searchIndexedAt).toBe(searchIndexedAt);
    });

    it("MessageMongo preserves class defaults for fields omitted from a partial override object.", () => {
        const obj = new MessageMongo({});

        expect(obj.folderUid).toBe("");
        expect(obj.mailboxUid).toBe("");
        expect(obj.messageId).toBe("");
        expect(obj.subject).toBe("");
        expect(obj.from).toEqual({ address: "", type: RecipientType.TO });
        expect(obj.recipients).toEqual([]);
        expect(obj.sentDate).toBeInstanceOf(Date);
        expect(obj.receivedDate).toBeInstanceOf(Date);
        expect(obj.bodyBlobKey).toBe("");
        expect(obj.bodyPreview).toBe("");
        expect(obj.flags).toEqual({ read: false, flagged: false, answered: false, forwarded: false });
        expect(obj.importance).toBe(MessageImportance.NORMAL);
        expect(obj.inReplyTo).toBeUndefined();
        expect(obj.references).toEqual([]);
        expect(obj.hasAttachments).toBe(false);
        expect(obj.scanResultUid).toBeUndefined();
        expect(obj.searchIndexedAt).toBeUndefined();
    });

    it("AttachmentMongo falls back to class defaults when constructed with no data.", () => {
        const obj = new AttachmentMongo();

        expect(obj.messageUid).toBe("");
        expect(obj.folderUid).toBe("");
        expect(obj.mailboxUid).toBe("");
        expect(obj.filename).toBe("");
        expect(obj.mimeType).toBe("");
        expect(obj.sizeBytes).toBe(0);
        expect(obj.blobKey).toBe("");
        expect(obj.contentId).toBeUndefined();
        expect(obj.isInline).toBe(false);
        expect(obj.extractedTextBlobKey).toBeUndefined();
        expect(obj.scanResultUid).toBeUndefined();
    });

    it("AttachmentMongo applies provided overrides when constructed with data.", () => {
        const obj = new AttachmentMongo({
            messageUid: "message-1",
            folderUid: "folder-1",
            mailboxUid: "mailbox-1",
            filename: "invoice.pdf",
            mimeType: "application/pdf",
            sizeBytes: 2048,
            blobKey: "blob-1",
            contentId: "<content-1>",
            isInline: true,
            extractedTextBlobKey: "extracted-1",
            scanResultUid: "scan-1",
        });

        expect(obj.messageUid).toBe("message-1");
        expect(obj.folderUid).toBe("folder-1");
        expect(obj.mailboxUid).toBe("mailbox-1");
        expect(obj.filename).toBe("invoice.pdf");
        expect(obj.mimeType).toBe("application/pdf");
        expect(obj.sizeBytes).toBe(2048);
        expect(obj.blobKey).toBe("blob-1");
        expect(obj.contentId).toBe("<content-1>");
        expect(obj.isInline).toBe(true);
        expect(obj.extractedTextBlobKey).toBe("extracted-1");
        expect(obj.scanResultUid).toBe("scan-1");
    });

    it("ContactMongo falls back to class defaults when constructed with no data.", () => {
        const obj = new ContactMongo();

        expect(obj.mailboxUid).toBe("");
        expect(obj.folderUid).toBe("");
        expect(obj.contactListUid).toBeUndefined();
        expect(obj.displayName).toBe("");
        expect(obj.givenName).toBeUndefined();
        expect(obj.surname).toBeUndefined();
        expect(obj.emails).toEqual([]);
        expect(obj.phones).toEqual([]);
        expect(obj.addresses).toEqual([]);
        expect(obj.company).toBeUndefined();
        expect(obj.jobTitle).toBeUndefined();
        expect(obj.notes).toBeUndefined();
        expect(obj.photoBlobKey).toBeUndefined();
        expect(obj.sourceUid).toBeUndefined();
    });

    it("ContactMongo applies provided overrides when constructed with data.", () => {
        const obj = new ContactMongo({
            mailboxUid: "mailbox-1",
            folderUid: "folder-1",
            contactListUid: "contactlist-1",
            displayName: "Jane Doe",
            givenName: "Jane",
            surname: "Doe",
            emails: [{ address: "jane@example.com", type: ContactAddressKind.HOME }],
            phones: [{ phoneNumber: "555-1234", type: ContactAddressKind.WORK }],
            addresses: [{ street: "1 Main St", city: "Anytown", type: ContactAddressKind.HOME }],
            company: "Acme Inc.",
            jobTitle: "Engineer",
            notes: "Met at conference",
            photoBlobKey: "photo-1",
            sourceUid: "gal-1",
        });

        expect(obj.mailboxUid).toBe("mailbox-1");
        expect(obj.folderUid).toBe("folder-1");
        expect(obj.contactListUid).toBe("contactlist-1");
        expect(obj.displayName).toBe("Jane Doe");
        expect(obj.givenName).toBe("Jane");
        expect(obj.surname).toBe("Doe");
        expect(obj.emails).toEqual([{ address: "jane@example.com", type: ContactAddressKind.HOME }]);
        expect(obj.phones).toEqual([{ phoneNumber: "555-1234", type: ContactAddressKind.WORK }]);
        expect(obj.addresses).toEqual([{ street: "1 Main St", city: "Anytown", type: ContactAddressKind.HOME }]);
        expect(obj.company).toBe("Acme Inc.");
        expect(obj.jobTitle).toBe("Engineer");
        expect(obj.notes).toBe("Met at conference");
        expect(obj.photoBlobKey).toBe("photo-1");
        expect(obj.sourceUid).toBe("gal-1");
    });

    it("ContactListMongo falls back to class defaults when constructed with no data.", () => {
        const obj = new ContactListMongo();

        expect(obj.mailboxUid).toBe("");
        expect(obj.name).toBe("");
    });

    it("ContactListMongo applies provided overrides when constructed with data.", () => {
        const obj = new ContactListMongo({ mailboxUid: "mailbox-1", name: "Friends" });

        expect(obj.mailboxUid).toBe("mailbox-1");
        expect(obj.name).toBe("Friends");
    });

    it("CalendarEventMongo falls back to class defaults when constructed with no data.", () => {
        const obj = new CalendarEventMongo();

        expect(obj.folderUid).toBe("");
        expect(obj.mailboxUid).toBe("");
        expect(obj.title).toBe("");
        expect(obj.location).toBeUndefined();
        expect(obj.startDate).toBeInstanceOf(Date);
        expect(obj.endDate).toBeInstanceOf(Date);
        expect(obj.allDay).toBe(false);
        expect(obj.timezone).toBe("");
        expect(obj.organizer).toEqual({ address: "", type: RecipientType.TO });
        expect(obj.attendees).toEqual([]);
        expect(obj.recurrenceRule).toBeUndefined();
        expect(obj.recurrenceId).toBeUndefined();
        expect(obj.status).toBe(CalendarEventStatus.CONFIRMED);
        expect(obj.busyStatus).toBe(BusyStatus.BUSY);
        expect(obj.reminderMinutesBeforeStart).toBeUndefined();
        expect(obj.icalUid).toBe("");
        expect(obj.sequence).toBe(0);
    });

    it("CalendarEventMongo applies provided overrides when constructed with data.", () => {
        const startDate = new Date("2026-03-01T10:00:00Z");
        const endDate = new Date("2026-03-01T11:00:00Z");
        const recurrenceId = new Date("2026-03-08T10:00:00Z");
        const obj = new CalendarEventMongo({
            folderUid: "folder-1",
            mailboxUid: "mailbox-1",
            title: "Team Sync",
            location: "Conference Room A",
            startDate,
            endDate,
            allDay: true,
            timezone: "America/New_York",
            organizer: { address: "organizer@example.com", type: RecipientType.TO },
            attendees: [
                {
                    address: "attendee@example.com",
                    role: AttendeeRole.REQUIRED,
                    responseStatus: AttendeeResponseStatus.ACCEPTED,
                    isOrganizer: false,
                },
            ],
            recurrenceRule: { freq: RecurrenceFrequency.WEEKLY, interval: 1, exceptions: [] },
            recurrenceId,
            status: CalendarEventStatus.CANCELLED,
            busyStatus: BusyStatus.FREE,
            reminderMinutesBeforeStart: 15,
            icalUid: "ical-uid-1",
            sequence: 2,
        });

        expect(obj.folderUid).toBe("folder-1");
        expect(obj.mailboxUid).toBe("mailbox-1");
        expect(obj.title).toBe("Team Sync");
        expect(obj.location).toBe("Conference Room A");
        expect(obj.startDate).toBe(startDate);
        expect(obj.endDate).toBe(endDate);
        expect(obj.allDay).toBe(true);
        expect(obj.timezone).toBe("America/New_York");
        expect(obj.organizer).toEqual({ address: "organizer@example.com", type: RecipientType.TO });
        expect(obj.attendees).toEqual([
            {
                address: "attendee@example.com",
                role: AttendeeRole.REQUIRED,
                responseStatus: AttendeeResponseStatus.ACCEPTED,
                isOrganizer: false,
            },
        ]);
        expect(obj.recurrenceRule).toEqual({ freq: RecurrenceFrequency.WEEKLY, interval: 1, exceptions: [] });
        expect(obj.recurrenceId).toBe(recurrenceId);
        expect(obj.status).toBe(CalendarEventStatus.CANCELLED);
        expect(obj.busyStatus).toBe(BusyStatus.FREE);
        expect(obj.reminderMinutesBeforeStart).toBe(15);
        expect(obj.icalUid).toBe("ical-uid-1");
        expect(obj.sequence).toBe(2);
    });

    it("CalendarShareLinkMongo falls back to class defaults when constructed with no data.", () => {
        const obj = new CalendarShareLinkMongo();

        expect(obj.token).toBe("");
        expect(obj.folderUid).toBe("");
        expect(obj.permittedActions).toEqual([]);
        expect(obj.expiresAt).toBeUndefined();
        expect(obj.createdByUserUid).toBe("");
    });

    it("CalendarShareLinkMongo applies provided overrides when constructed with data.", () => {
        const expiresAt = new Date("2026-06-01T00:00:00Z");
        const obj = new CalendarShareLinkMongo({
            token: "token-1",
            folderUid: "folder-1",
            permittedActions: ["freebusy"],
            expiresAt,
            createdByUserUid: "user-1",
        });

        expect(obj.token).toBe("token-1");
        expect(obj.folderUid).toBe("folder-1");
        expect(obj.permittedActions).toEqual(["freebusy"]);
        expect(obj.expiresAt).toBe(expiresAt);
        expect(obj.createdByUserUid).toBe("user-1");
    });

    it("TaskMongo falls back to class defaults when constructed with no data.", () => {
        const obj = new TaskMongo();

        expect(obj.mailboxUid).toBe("");
        expect(obj.folderUid).toBe("");
        expect(obj.title).toBe("");
        expect(obj.body).toBeUndefined();
        expect(obj.dueDate).toBeUndefined();
        expect(obj.completed).toBe(false);
        expect(obj.priority).toBe(TaskPriority.NORMAL);
        expect(obj.reminderDate).toBeUndefined();
    });

    it("TaskMongo applies provided overrides when constructed with data.", () => {
        const dueDate = new Date("2026-04-01T00:00:00Z");
        const reminderDate = new Date("2026-03-31T00:00:00Z");
        const obj = new TaskMongo({
            mailboxUid: "mailbox-1",
            folderUid: "folder-1",
            title: "File taxes",
            body: "Don't forget receipts",
            dueDate,
            completed: true,
            priority: TaskPriority.HIGH,
            reminderDate,
        });

        expect(obj.mailboxUid).toBe("mailbox-1");
        expect(obj.folderUid).toBe("folder-1");
        expect(obj.title).toBe("File taxes");
        expect(obj.body).toBe("Don't forget receipts");
        expect(obj.dueDate).toBe(dueDate);
        expect(obj.completed).toBe(true);
        expect(obj.priority).toBe(TaskPriority.HIGH);
        expect(obj.reminderDate).toBe(reminderDate);
    });

    it("NoteMongo falls back to class defaults when constructed with no data.", () => {
        const obj = new NoteMongo();

        expect(obj.mailboxUid).toBe("");
        expect(obj.folderUid).toBe("");
        expect(obj.title).toBe("");
        expect(obj.body).toBe("");
        expect(obj.color).toBeUndefined();
    });

    it("NoteMongo applies provided overrides when constructed with data.", () => {
        const obj = new NoteMongo({
            mailboxUid: "mailbox-1",
            folderUid: "folder-1",
            title: "Reminder",
            body: "Buy milk",
            color: "#ffcc00",
        });

        expect(obj.mailboxUid).toBe("mailbox-1");
        expect(obj.folderUid).toBe("folder-1");
        expect(obj.title).toBe("Reminder");
        expect(obj.body).toBe("Buy milk");
        expect(obj.color).toBe("#ffcc00");
    });

    it("ScanResultMongo falls back to class defaults when constructed with no data.", () => {
        const obj = new ScanResultMongo();

        expect(obj.targetType).toBe(ScanTargetType.MESSAGE);
        expect(obj.targetUid).toBe("");
        expect(obj.spamScore).toBe(0);
        expect(obj.spamVerdict).toBe(SpamVerdict.CLEAN);
        expect(obj.spamSymbols).toEqual([]);
        expect(obj.avVerdict).toBe(AvVerdict.CLEAN);
        expect(obj.avSignatureName).toBeUndefined();
        expect(obj.scannedAt).toBeInstanceOf(Date);
        expect(obj.providerVersions).toEqual({});
    });

    it("ScanResultMongo applies provided overrides when constructed with data.", () => {
        const scannedAt = new Date("2026-02-01T00:00:00Z");
        const obj = new ScanResultMongo({
            targetType: ScanTargetType.ATTACHMENT,
            targetUid: "attachment-1",
            spamScore: 9.5,
            spamVerdict: SpamVerdict.SPAM,
            spamSymbols: ["BAD_HEADER"],
            avVerdict: AvVerdict.INFECTED,
            avSignatureName: "Eicar-Test-Signature",
            scannedAt,
            providerVersions: { spam: "1.0", av: "2.0" },
        });

        expect(obj.targetType).toBe(ScanTargetType.ATTACHMENT);
        expect(obj.targetUid).toBe("attachment-1");
        expect(obj.spamScore).toBe(9.5);
        expect(obj.spamVerdict).toBe(SpamVerdict.SPAM);
        expect(obj.spamSymbols).toEqual(["BAD_HEADER"]);
        expect(obj.avVerdict).toBe(AvVerdict.INFECTED);
        expect(obj.avSignatureName).toBe("Eicar-Test-Signature");
        expect(obj.scannedAt).toBe(scannedAt);
        expect(obj.providerVersions).toEqual({ spam: "1.0", av: "2.0" });
    });

    it("ScanResultMongo preserves class defaults for fields omitted from a partial override object.", () => {
        const obj = new ScanResultMongo({});

        expect(obj.targetType).toBe(ScanTargetType.MESSAGE);
        expect(obj.targetUid).toBe("");
        expect(obj.spamScore).toBe(0);
        expect(obj.spamVerdict).toBe(SpamVerdict.CLEAN);
        expect(obj.spamSymbols).toEqual([]);
        expect(obj.avVerdict).toBe(AvVerdict.CLEAN);
        expect(obj.avSignatureName).toBeUndefined();
        expect(obj.scannedAt).toBeInstanceOf(Date);
        expect(obj.providerVersions).toEqual({});
    });

    it("QuarantineEntryMongo falls back to class defaults when constructed with no data.", () => {
        const obj = new QuarantineEntryMongo();

        expect(obj.mailboxUid).toBe("");
        expect(obj.originalMessageUid).toBeUndefined();
        expect(obj.reason).toBe(QuarantineReason.OTHER);
        expect(obj.scanResultUid).toBe("");
        expect(obj.rawBlobKey).toBe("");
        expect(obj.releasedAt).toBeUndefined();
        expect(obj.releasedByUserUid).toBeUndefined();
    });

    it("QuarantineEntryMongo applies provided overrides when constructed with data.", () => {
        const releasedAt = new Date("2026-05-01T00:00:00Z");
        const obj = new QuarantineEntryMongo({
            mailboxUid: "mailbox-1",
            originalMessageUid: "message-1",
            reason: QuarantineReason.INFECTED,
            scanResultUid: "scan-1",
            rawBlobKey: "blob-1",
            releasedAt,
            releasedByUserUid: "user-1",
        });

        expect(obj.mailboxUid).toBe("mailbox-1");
        expect(obj.originalMessageUid).toBe("message-1");
        expect(obj.reason).toBe(QuarantineReason.INFECTED);
        expect(obj.scanResultUid).toBe("scan-1");
        expect(obj.rawBlobKey).toBe("blob-1");
        expect(obj.releasedAt).toBe(releasedAt);
        expect(obj.releasedByUserUid).toBe("user-1");
    });

    it("QuarantineEntryMongo preserves class defaults for fields omitted from a partial override object.", () => {
        const obj = new QuarantineEntryMongo({});

        expect(obj.mailboxUid).toBe("");
        expect(obj.originalMessageUid).toBeUndefined();
        expect(obj.reason).toBe(QuarantineReason.OTHER);
        expect(obj.scanResultUid).toBe("");
        expect(obj.rawBlobKey).toBe("");
        expect(obj.releasedAt).toBeUndefined();
        expect(obj.releasedByUserUid).toBeUndefined();
    });

    it("SearchIndexStateMongo falls back to class defaults when constructed with no data.", () => {
        const obj = new SearchIndexStateMongo();

        expect(obj.entityType).toBe("");
        expect(obj.entityUid).toBe("");
        expect(obj.provider).toBe("");
        expect(obj.indexedAt).toBeInstanceOf(Date);
        expect(obj.contentHash).toBe("");
    });

    it("SearchIndexStateMongo applies provided overrides when constructed with data.", () => {
        const indexedAt = new Date("2026-01-15T00:00:00Z");
        const obj = new SearchIndexStateMongo({
            entityType: "Message",
            entityUid: "message-1",
            provider: "opensearch",
            indexedAt,
            contentHash: "abc123",
        });

        expect(obj.entityType).toBe("Message");
        expect(obj.entityUid).toBe("message-1");
        expect(obj.provider).toBe("opensearch");
        expect(obj.indexedAt).toBe(indexedAt);
        expect(obj.contentHash).toBe("abc123");
    });

    it("SearchIndexStateMongo preserves class defaults for fields omitted from a partial override object.", () => {
        const obj = new SearchIndexStateMongo({});

        expect(obj.entityType).toBe("");
        expect(obj.entityUid).toBe("");
        expect(obj.provider).toBe("");
        expect(obj.indexedAt).toBeInstanceOf(Date);
        expect(obj.contentHash).toBe("");
    });

    it("IngestQueueEntryMongo falls back to class defaults when constructed with no data.", () => {
        const obj = new IngestQueueEntryMongo();

        expect(obj.mailboxUid).toBe("");
        expect(obj.envelopeFrom).toBe("");
        expect(obj.envelopeTo).toEqual([]);
        expect(obj.rawBlobKey).toBe("");
        expect(obj.status).toBe(IngestStatus.PENDING);
        expect(obj.errorMessage).toBeUndefined();
    });

    it("IngestQueueEntryMongo applies provided overrides when constructed with data.", () => {
        const obj = new IngestQueueEntryMongo({
            mailboxUid: "mailbox-1",
            envelopeFrom: "sender@example.com",
            envelopeTo: ["recipient@example.com"],
            rawBlobKey: "blob-1",
            status: IngestStatus.FAILED,
            errorMessage: "parse error",
        });

        expect(obj.mailboxUid).toBe("mailbox-1");
        expect(obj.envelopeFrom).toBe("sender@example.com");
        expect(obj.envelopeTo).toEqual(["recipient@example.com"]);
        expect(obj.rawBlobKey).toBe("blob-1");
        expect(obj.status).toBe(IngestStatus.FAILED);
        expect(obj.errorMessage).toBe("parse error");
    });

    it("IngestQueueEntryMongo preserves class defaults for fields omitted from a partial override object.", () => {
        const obj = new IngestQueueEntryMongo({});

        expect(obj.mailboxUid).toBe("");
        expect(obj.envelopeFrom).toBe("");
        expect(obj.envelopeTo).toEqual([]);
        expect(obj.rawBlobKey).toBe("");
        expect(obj.status).toBe(IngestStatus.PENDING);
        expect(obj.errorMessage).toBeUndefined();
    });

    it("DeviceSyncStateMongo falls back to class defaults when constructed with no data.", () => {
        const obj = new DeviceSyncStateMongo();

        expect(obj.mailboxUid).toBe("");
        expect(obj.deviceId).toBe("");
        expect(obj.deviceType).toBe("");
        expect(obj.policyKey).toBeUndefined();
        expect(obj.folderSyncKeys).toEqual({});
        expect(obj.lastSyncAt).toBeUndefined();
        expect(obj.provisioned).toBe(false);
    });

    it("DeviceSyncStateMongo applies provided overrides when constructed with data.", () => {
        const lastSyncAt = new Date("2026-01-20T00:00:00Z");
        const obj = new DeviceSyncStateMongo({
            mailboxUid: "mailbox-1",
            deviceId: "device-1",
            deviceType: "iPhone",
            policyKey: "policy-1",
            folderSyncKeys: { "folder-1": "synckey-1" },
            lastSyncAt,
            provisioned: true,
        });

        expect(obj.mailboxUid).toBe("mailbox-1");
        expect(obj.deviceId).toBe("device-1");
        expect(obj.deviceType).toBe("iPhone");
        expect(obj.policyKey).toBe("policy-1");
        expect(obj.folderSyncKeys).toEqual({ "folder-1": "synckey-1" });
        expect(obj.lastSyncAt).toBe(lastSyncAt);
        expect(obj.provisioned).toBe(true);
    });

    it("DeviceSyncStateMongo preserves class defaults for fields omitted from a partial override object.", () => {
        const obj = new DeviceSyncStateMongo({});

        expect(obj.mailboxUid).toBe("");
        expect(obj.deviceId).toBe("");
        expect(obj.deviceType).toBe("");
        expect(obj.policyKey).toBeUndefined();
        expect(obj.folderSyncKeys).toEqual({});
        expect(obj.lastSyncAt).toBeUndefined();
        expect(obj.provisioned).toBe(false);
    });
});
