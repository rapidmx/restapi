///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    AttendeeResponseStatus,
    AttendeeRole,
    AuditAction,
    AvVerdict,
    BusyStatus,
    CalendarEventStatus,
    ContactAddressKind,
    FolderType,
    IngestStatus,
    MessageClassification,
    MessageImportance,
    QuarantineReason,
    RecipientType,
    RecurrenceFrequency,
    ScanTargetType,
    SpamVerdict,
    TaskPriority,
    TransportRuleActionType,
} from "../../src/models/types.js";
import { AttachmentSQL } from "../../src/models/sql/AttachmentSQL.js";
import { AuditLogEntrySQL } from "../../src/models/sql/AuditLogEntrySQL.js";
import { BrandingSQL } from "../../src/models/sql/BrandingSQL.js";
import { CalendarEventAttendeeLinkSQL } from "../../src/models/sql/CalendarEventAttendeeLinkSQL.js";
import { CalendarEventSQL } from "../../src/models/sql/CalendarEventSQL.js";
import { CalendarShareLinkSQL } from "../../src/models/sql/CalendarShareLinkSQL.js";
import { ContactSQL } from "../../src/models/sql/ContactSQL.js";
import { ContactListSQL } from "../../src/models/sql/ContactListSQL.js";
import { DistributionListSQL } from "../../src/models/sql/DistributionListSQL.js";
import { DomainSQL } from "../../src/models/sql/DomainSQL.js";
import { EscrowAccessRequestSQL } from "../../src/models/sql/EscrowAccessRequestSQL.js";
import { FocusedInboxOverrideSQL } from "../../src/models/sql/FocusedInboxOverrideSQL.js";
import { FolderSQL } from "../../src/models/sql/FolderSQL.js";
import { IngestQueueEntrySQL } from "../../src/models/sql/IngestQueueEntrySQL.js";
import { KeyVaultSQL } from "../../src/models/sql/KeyVaultSQL.js";
import { MailboxSQL } from "../../src/models/sql/MailboxSQL.js";
import { MessageSQL } from "../../src/models/sql/MessageSQL.js";
import { NoteSQL } from "../../src/models/sql/NoteSQL.js";
import { QuarantineEntrySQL } from "../../src/models/sql/QuarantineEntrySQL.js";
import { ScanResultSQL } from "../../src/models/sql/ScanResultSQL.js";
import { SearchIndexStateSQL } from "../../src/models/sql/SearchIndexStateSQL.js";
import { TaskSQL } from "../../src/models/sql/TaskSQL.js";
import { TransportRuleSQL } from "../../src/models/sql/TransportRuleSQL.js";

describe("SQL model default construction", () => {
    it("MailboxSQL falls back to class defaults when constructed with no data.", () => {
        const obj = new MailboxSQL();

        expect(obj.ownerUserUid).toBeUndefined();
        expect(obj.primarySmtpAddress).toBe("");
        expect(obj.aliasAddresses).toEqual([]);
        expect(obj.displayName).toBe("");
        expect(obj.timezone).toBe("");
        expect(obj.quotaBytes).toBe(0);
        expect(obj.usedBytes).toBe(0);
        expect(obj.oofEnabled).toBe(false);
        expect(obj.oofMessage).toBe("");
        expect(obj.oofStartTime).toBeUndefined();
        expect(obj.oofEndTime).toBeUndefined();
        expect(obj.alwaysRequestReceiptInternal).toBe(true);
        expect(obj.alwaysRequestReceiptFederated).toBe(false);
        expect(obj.alwaysRequestReceiptExternal).toBe(false);
        expect(obj.autoSendReceiptsInternal).toBe(true);
        expect(obj.autoSendReceiptsFederated).toBe(false);
        expect(obj.autoSendReceiptsExternal).toBe(false);
        expect(obj.encryptPreference).toEqual({ preferEncrypt: "nopreference" });
        expect(obj.keys).toEqual([]);
        expect(obj.keyDiscoveryHash).toBeUndefined();
    });

    it("MailboxSQL applies provided overrides when constructed with data.", () => {
        const oofStartTime = new Date("2026-01-20T00:00:00Z");
        const oofEndTime = new Date("2026-01-27T00:00:00Z");
        const obj = new MailboxSQL({
            ownerUserUid: "user-1",
            primarySmtpAddress: "user@example.com",
            aliasAddresses: ["alias@example.com"],
            displayName: "Example User",
            timezone: "America/Los_Angeles",
            quotaBytes: 1000,
            usedBytes: 500,
            oofEnabled: true,
            oofMessage: "I am out of office.",
            oofStartTime,
            oofEndTime,
            alwaysRequestReceiptInternal: false,
            alwaysRequestReceiptFederated: true,
            alwaysRequestReceiptExternal: true,
            autoSendReceiptsInternal: false,
            autoSendReceiptsFederated: true,
            autoSendReceiptsExternal: true,
            encryptPreference: { preferEncrypt: "mutual", lastSeen: 123 },
            keys: [{ publicKey: "abc", type: "x509", useType: "encrypt", fingerprint: "fp", notBefore: 0, notAfter: 1 }],
            keyDiscoveryHash: "hash123",
        });

        expect(obj.ownerUserUid).toBe("user-1");
        expect(obj.primarySmtpAddress).toBe("user@example.com");
        expect(obj.aliasAddresses).toEqual(["alias@example.com"]);
        expect(obj.displayName).toBe("Example User");
        expect(obj.timezone).toBe("America/Los_Angeles");
        expect(obj.quotaBytes).toBe(1000);
        expect(obj.usedBytes).toBe(500);
        expect(obj.oofEnabled).toBe(true);
        expect(obj.oofMessage).toBe("I am out of office.");
        expect(obj.oofStartTime).toBe(oofStartTime);
        expect(obj.oofEndTime).toBe(oofEndTime);
        expect(obj.alwaysRequestReceiptInternal).toBe(false);
        expect(obj.alwaysRequestReceiptFederated).toBe(true);
        expect(obj.alwaysRequestReceiptExternal).toBe(true);
        expect(obj.autoSendReceiptsInternal).toBe(false);
        expect(obj.autoSendReceiptsFederated).toBe(true);
        expect(obj.autoSendReceiptsExternal).toBe(true);
        expect(obj.encryptPreference).toEqual({ preferEncrypt: "mutual", lastSeen: 123 });
        expect(obj.keys).toEqual([
            { publicKey: "abc", type: "x509", useType: "encrypt", fingerprint: "fp", notBefore: 0, notAfter: 1 },
        ]);
        expect(obj.keyDiscoveryHash).toBe("hash123");
    });

    it("MailboxSQL preserves class defaults for fields omitted from a partial override object.", () => {
        const obj = new MailboxSQL({});

        expect(obj.oofEnabled).toBe(false);
        expect(obj.oofMessage).toBe("");
        expect(obj.oofStartTime).toBeUndefined();
        expect(obj.oofEndTime).toBeUndefined();
        expect(obj.alwaysRequestReceiptInternal).toBe(true);
        expect(obj.alwaysRequestReceiptFederated).toBe(false);
        expect(obj.alwaysRequestReceiptExternal).toBe(false);
        expect(obj.autoSendReceiptsInternal).toBe(true);
        expect(obj.autoSendReceiptsFederated).toBe(false);
        expect(obj.autoSendReceiptsExternal).toBe(false);
        expect(obj.encryptPreference).toEqual({ preferEncrypt: "nopreference" });
        expect(obj.keys).toEqual([]);
        expect(obj.keyDiscoveryHash).toBeUndefined();
    });

    it("FolderSQL falls back to class defaults when constructed with no data.", () => {
        const obj = new FolderSQL();

        expect(obj.mailboxUid).toBe("");
        expect(obj.name).toBe("");
        expect(obj.type).toBe(FolderType.USER);
        expect(obj.parentFolderUid).toBeUndefined();
        expect(obj.unreadCount).toBe(0);
        expect(obj.totalCount).toBe(0);
        expect(obj.syncKeyVersion).toBe(0);
    });

    it("FolderSQL applies provided overrides when constructed with data.", () => {
        const obj = new FolderSQL({
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

    it("MessageSQL falls back to class defaults when constructed with no data.", () => {
        const obj = new MessageSQL();

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
        expect(obj.labelUids).toEqual([]);
        expect(obj.encrypted).toBe(false);
        expect(obj.scanResultUid).toBeUndefined();
        expect(obj.searchIndexedAt).toBeUndefined();
        expect(obj.requestReceipt).toBeUndefined();
        expect(obj.dispositionNotificationTo).toBeUndefined();
        expect(obj.deliveryReceiptSentAt).toBeUndefined();
        expect(obj.readReceiptSentAt).toBeUndefined();
        expect(obj.deliveryReceiptPending).toBe(false);
        expect(obj.readReceiptPending).toBe(false);
        expect(obj.receiptStatus).toBeUndefined();
    });

    it("MessageSQL applies provided overrides when constructed with data.", () => {
        const sentDate = new Date("2026-01-01T00:00:00Z");
        const receivedDate = new Date("2026-01-01T00:01:00Z");
        const searchIndexedAt = new Date("2026-01-02T00:00:00Z");
        const deliveryReceiptSentAt = new Date("2026-01-01T00:05:00Z");
        const readReceiptSentAt = new Date("2026-01-01T00:10:00Z");
        const obj = new MessageSQL({
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
            labelUids: ["label-1"],
            encrypted: true,
            scanResultUid: "scan-1",
            searchIndexedAt,
            inferenceClassification: MessageClassification.OTHER,
            requestReceipt: true,
            dispositionNotificationTo: "sender@example.com",
            deliveryReceiptSentAt,
            readReceiptSentAt,
            deliveryReceiptPending: true,
            readReceiptPending: true,
            receiptStatus: [{ recipientAddress: "to@example.com", deliveredAt: "2026-01-01T00:02:00.000Z" }],
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
        expect(obj.labelUids).toEqual(["label-1"]);
        expect(obj.encrypted).toBe(true);
        expect(obj.scanResultUid).toBe("scan-1");
        expect(obj.searchIndexedAt).toBe(searchIndexedAt);
        expect(obj.inferenceClassification).toBe(MessageClassification.OTHER);
        expect(obj.requestReceipt).toBe(true);
        expect(obj.dispositionNotificationTo).toBe("sender@example.com");
        expect(obj.deliveryReceiptSentAt).toBe(deliveryReceiptSentAt);
        expect(obj.readReceiptSentAt).toBe(readReceiptSentAt);
        expect(obj.deliveryReceiptPending).toBe(true);
        expect(obj.readReceiptPending).toBe(true);
        expect(obj.receiptStatus).toEqual([{ recipientAddress: "to@example.com", deliveredAt: "2026-01-01T00:02:00.000Z" }]);
    });

    it("MessageSQL preserves class defaults for fields omitted from a partial override object.", () => {
        const obj = new MessageSQL({});

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
        expect(obj.labelUids).toEqual([]);
        expect(obj.encrypted).toBe(false);
        expect(obj.scanResultUid).toBeUndefined();
        expect(obj.searchIndexedAt).toBeUndefined();
        expect(obj.requestReceipt).toBeUndefined();
        expect(obj.dispositionNotificationTo).toBeUndefined();
        expect(obj.deliveryReceiptSentAt).toBeUndefined();
        expect(obj.readReceiptSentAt).toBeUndefined();
        expect(obj.deliveryReceiptPending).toBe(false);
        expect(obj.readReceiptPending).toBe(false);
        expect(obj.receiptStatus).toBeUndefined();
    });

    it("AttachmentSQL falls back to class defaults when constructed with no data.", () => {
        const obj = new AttachmentSQL();

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

    it("AttachmentSQL applies provided overrides when constructed with data.", () => {
        const obj = new AttachmentSQL({
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

    it("ContactSQL falls back to class defaults when constructed with no data.", () => {
        const obj = new ContactSQL();

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
        expect(obj.encryptPreference).toBeUndefined();
        expect(obj.keys).toBeUndefined();
        expect(obj.keysFirstSeen).toBeUndefined();
        expect(obj.lastMessageSeen).toBeUndefined();
        expect(obj.keyConflicts).toBeUndefined();
        expect(obj.previousKeys).toBeUndefined();
        expect(obj.rejectedKeys).toBeUndefined();
    });

    it("ContactSQL applies provided overrides when constructed with data.", () => {
        const obj = new ContactSQL({
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
            encryptPreference: { preferEncrypt: "mutual", lastSeen: 100 },
            keys: [{ publicKey: "abc", type: "x509", useType: "sign", fingerprint: "fp", notBefore: 0, notAfter: 1 }],
            keysFirstSeen: 50,
            lastMessageSeen: 200,
            keyConflicts: [
                {
                    useType: "sign",
                    observedKey: { publicKey: "def", type: "x509", useType: "sign", fingerprint: "other-fp", notBefore: 0, notAfter: 1 },
                    observedAt: 150,
                    source: "header",
                },
            ],
            previousKeys: [
                { publicKey: "old", type: "x509", useType: "sign", fingerprint: "old-fp", notBefore: 0, notAfter: 1, replacedAt: 120, replacement: "user" },
            ],
            rejectedKeys: [{ useType: "encrypt", fingerprint: "bad-fp", rejectedAt: 130 }],
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
        expect(obj.encryptPreference).toEqual({ preferEncrypt: "mutual", lastSeen: 100 });
        expect(obj.keys).toEqual([
            { publicKey: "abc", type: "x509", useType: "sign", fingerprint: "fp", notBefore: 0, notAfter: 1 },
        ]);
        expect(obj.keysFirstSeen).toBe(50);
        expect(obj.lastMessageSeen).toBe(200);
        expect(obj.keyConflicts).toEqual([expect.objectContaining({ useType: "sign", observedAt: 150, source: "header" })]);
        expect(obj.previousKeys).toEqual([expect.objectContaining({ fingerprint: "old-fp", replacedAt: 120, replacement: "user" })]);
        expect(obj.rejectedKeys).toEqual([{ useType: "encrypt", fingerprint: "bad-fp", rejectedAt: 130 }]);
    });

    it("ContactSQL preserves class defaults for the key-discovery fields omitted from a partial override object.", () => {
        const obj = new ContactSQL({ displayName: "Jane Doe" });

        expect(obj.encryptPreference).toBeUndefined();
        expect(obj.keys).toBeUndefined();
        expect(obj.keysFirstSeen).toBeUndefined();
        expect(obj.lastMessageSeen).toBeUndefined();
        expect(obj.keyConflicts).toBeUndefined();
        expect(obj.previousKeys).toBeUndefined();
        expect(obj.rejectedKeys).toBeUndefined();
    });

    it("KeyVaultSQL falls back to class defaults when constructed with no data.", () => {
        const obj = new KeyVaultSQL();

        expect(obj.mailboxUid).toBe("");
        expect(obj.wrappedKeys).toEqual([]);
        expect(obj.masterKeyWraps).toEqual([]);
    });

    it("KeyVaultSQL applies provided overrides when constructed with data.", () => {
        const obj = new KeyVaultSQL({
            mailboxUid: "mailbox-1",
            wrappedKeys: [{ ciphertext: "ct", nonce: "n", algorithm: "AES-256-GCM", fingerprint: "fp", useType: "encrypt" }],
            masterKeyWraps: [
                {
                    method: "password",
                    ciphertext: "mkct",
                    nonce: "mkn",
                    salt: "salt",
                    kdf: "argon2id:m=65536,t=3,p=4",
                    schemeVersion: 1,
                    createdAt: 100,
                },
            ],
        });

        expect(obj.mailboxUid).toBe("mailbox-1");
        expect(obj.wrappedKeys).toEqual([
            { ciphertext: "ct", nonce: "n", algorithm: "AES-256-GCM", fingerprint: "fp", useType: "encrypt" },
        ]);
        expect(obj.masterKeyWraps).toEqual([
            {
                method: "password",
                ciphertext: "mkct",
                nonce: "mkn",
                salt: "salt",
                kdf: "argon2id:m=65536,t=3,p=4",
                schemeVersion: 1,
                createdAt: 100,
            },
        ]);
    });

    it("KeyVaultSQL preserves class defaults for fields omitted from a partial override object.", () => {
        const obj = new KeyVaultSQL({});

        expect(obj.wrappedKeys).toEqual([]);
        expect(obj.masterKeyWraps).toEqual([]);
    });

    it("ContactListSQL falls back to class defaults when constructed with no data.", () => {
        const obj = new ContactListSQL();

        expect(obj.mailboxUid).toBe("");
        expect(obj.name).toBe("");
    });

    it("ContactListSQL applies provided overrides when constructed with data.", () => {
        const obj = new ContactListSQL({ mailboxUid: "mailbox-1", name: "Friends" });

        expect(obj.mailboxUid).toBe("mailbox-1");
        expect(obj.name).toBe("Friends");
    });

    it("DistributionListSQL falls back to class defaults when constructed with no data.", () => {
        const obj = new DistributionListSQL();

        expect(obj.primarySmtpAddress).toBe("");
        expect(obj.aliasAddresses).toEqual([]);
        expect(obj.name).toBe("");
        expect(obj.description).toBeUndefined();
        expect(obj.ownerUserUid).toBeUndefined();
        expect(obj.memberAddresses).toEqual([]);
        expect(obj.restrictSenders).toBe(false);
    });

    it("DistributionListSQL applies provided overrides when constructed with data.", () => {
        const obj = new DistributionListSQL({
            primarySmtpAddress: "sales@example.com",
            aliasAddresses: ["sales-team@example.com"],
            name: "Sales",
            description: "Sales team distribution list",
            ownerUserUid: "user-1",
            memberAddresses: ["a@example.com", "b@example.com"],
            restrictSenders: true,
        });

        expect(obj.primarySmtpAddress).toBe("sales@example.com");
        expect(obj.aliasAddresses).toEqual(["sales-team@example.com"]);
        expect(obj.name).toBe("Sales");
        expect(obj.description).toBe("Sales team distribution list");
        expect(obj.ownerUserUid).toBe("user-1");
        expect(obj.memberAddresses).toEqual(["a@example.com", "b@example.com"]);
        expect(obj.restrictSenders).toBe(true);
    });

    it("DomainSQL falls back to class defaults when constructed with no data.", () => {
        const obj = new DomainSQL();

        expect(obj.name).toBe("");
        expect(obj.enabled).toBe(true);
        expect(obj.verified).toBe(false);
        expect(obj.verificationToken).toBe("");
        expect(obj.verifiedAt).toBeUndefined();
        expect(obj.lastCheckedAt).toBeUndefined();
        expect(obj.dkimSelector).toBeUndefined();
        expect(obj.dkimPublicKey).toBeUndefined();
        expect(obj.dmarcPolicy).toBeUndefined();
        expect(obj.dmarcReportEmail).toBeUndefined();
    });

    it("DomainSQL applies provided overrides when constructed with data.", () => {
        const verifiedAt = new Date();
        const lastCheckedAt = new Date();
        const obj = new DomainSQL({
            name: "example.com",
            enabled: false,
            verified: true,
            verificationToken: "abc123",
            verifiedAt,
            lastCheckedAt,
            dkimSelector: "default",
            dkimPublicKey: "MIGfMA0GCSq",
            dmarcPolicy: "quarantine",
            dmarcReportEmail: "dmarc@example.com",
        });

        expect(obj.name).toBe("example.com");
        expect(obj.enabled).toBe(false);
        expect(obj.verified).toBe(true);
        expect(obj.verificationToken).toBe("abc123");
        expect(obj.verifiedAt).toBe(verifiedAt);
        expect(obj.lastCheckedAt).toBe(lastCheckedAt);
        expect(obj.dkimSelector).toBe("default");
        expect(obj.dkimPublicKey).toBe("MIGfMA0GCSq");
        expect(obj.dmarcPolicy).toBe("quarantine");
        expect(obj.dmarcReportEmail).toBe("dmarc@example.com");
    });

    it("FocusedInboxOverrideSQL falls back to class defaults when constructed with no data.", () => {
        const obj = new FocusedInboxOverrideSQL();

        expect(obj.mailboxUid).toBe("");
        expect(obj.senderAddress).toBe("");
        expect(obj.classifyAs).toBe(MessageClassification.FOCUSED);
    });

    it("FocusedInboxOverrideSQL applies provided overrides when constructed with data.", () => {
        const obj = new FocusedInboxOverrideSQL({
            mailboxUid: "mailbox-1",
            senderAddress: "newsletter@example.com",
            classifyAs: MessageClassification.OTHER,
        });

        expect(obj.mailboxUid).toBe("mailbox-1");
        expect(obj.senderAddress).toBe("newsletter@example.com");
        expect(obj.classifyAs).toBe(MessageClassification.OTHER);
    });

    it("FocusedInboxOverrideSQL keeps class defaults for fields omitted from a partial constructor call.", () => {
        const obj = new FocusedInboxOverrideSQL({ mailboxUid: "mailbox-1" });

        expect(obj.mailboxUid).toBe("mailbox-1");
        expect(obj.senderAddress).toBe("");
        expect(obj.classifyAs).toBe(MessageClassification.FOCUSED);
    });

    it("FocusedInboxOverrideSQL keeps every class default when constructed with an empty partial object.", () => {
        const obj = new FocusedInboxOverrideSQL({});

        expect(obj.mailboxUid).toBe("");
    });

    it("EscrowAccessRequestSQL keeps class defaults for fields omitted from a partial constructor call.", () => {
        // No route ever constructs this model with a partial `other` - `persistCreate()` always
        // supplies every field, so the `!== undefined` ternary's false branch is otherwise unexercised.
        const obj = new EscrowAccessRequestSQL({ matterId: "matter-1", mailboxUid: "mailbox-1" });

        expect(obj.matterId).toBe("matter-1");
        expect(obj.mailboxUid).toBe("mailbox-1");
        expect(obj.requestedByUserUid).toBe("");
        expect(obj.approvals).toEqual([]);
        expect(obj.requiredHoldersAtCreation).toBe(1);
        expect(obj.status).toBe("pending");
    });

    it("EscrowAccessRequestSQL keeps every class default when constructed with an empty partial object.", () => {
        const obj = new EscrowAccessRequestSQL({});

        expect(obj.matterId).toBe("");
        expect(obj.mailboxUid).toBe("");
    });

    it("BrandingSQL keeps class defaults for fields omitted from a partial constructor call.", () => {
        const obj = new BrandingSQL({ title: "Acme Mail" });

        expect(obj.title).toBe("Acme Mail");
        expect(obj.companyName).toBe("");
    });

    it("BrandingSQL keeps every class default when constructed with an empty partial object.", () => {
        const obj = new BrandingSQL({});

        expect(obj.title).toBe("");
    });

    it("CalendarEventSQL falls back to class defaults when constructed with no data.", () => {
        const obj = new CalendarEventSQL();

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
        expect(obj.encryptionOrigin).toBe("none");
        expect(obj.videoMeetingUid).toBeUndefined();
    });

    it("CalendarEventSQL applies provided overrides when constructed with data.", () => {
        const startDate = new Date("2026-03-01T10:00:00Z");
        const endDate = new Date("2026-03-01T11:00:00Z");
        const recurrenceId = new Date("2026-03-08T10:00:00Z");
        const obj = new CalendarEventSQL({
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
            encryptionOrigin: "originated",
            videoMeetingUid: "meeting-1",
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
        expect(obj.encryptionOrigin).toBe("originated");
        expect(obj.videoMeetingUid).toBe("meeting-1");
    });

    it("CalendarEventAttendeeLinkSQL falls back to class defaults when constructed with no data.", () => {
        const obj = new CalendarEventAttendeeLinkSQL();

        expect(obj.mailboxUid).toBe("");
        expect(obj.calendarEventUid).toBe("");
        expect(obj.attendeeAddress).toBe("");
        expect(obj.url).toBe("");
        expect(obj.label).toBeUndefined();
    });

    it("CalendarEventAttendeeLinkSQL applies provided overrides when constructed with data.", () => {
        const obj = new CalendarEventAttendeeLinkSQL({
            mailboxUid: "mailbox-1",
            calendarEventUid: "event-1",
            attendeeAddress: "attendee@example.com",
            url: "https://video.example/join/abc",
            label: "Join video call",
        });

        expect(obj.mailboxUid).toBe("mailbox-1");
        expect(obj.calendarEventUid).toBe("event-1");
        expect(obj.attendeeAddress).toBe("attendee@example.com");
        expect(obj.url).toBe("https://video.example/join/abc");
        expect(obj.label).toBe("Join video call");
    });

    it("CalendarShareLinkSQL falls back to class defaults when constructed with no data.", () => {
        const obj = new CalendarShareLinkSQL();

        expect(obj.token).toBe("");
        expect(obj.folderUid).toBe("");
        expect(obj.permittedActions).toEqual([]);
        expect(obj.expiresAt).toBeUndefined();
        expect(obj.createdByUserUid).toBe("");
    });

    it("CalendarShareLinkSQL applies provided overrides when constructed with data.", () => {
        const expiresAt = new Date("2026-06-01T00:00:00Z");
        const obj = new CalendarShareLinkSQL({
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

    it("TaskSQL falls back to class defaults when constructed with no data.", () => {
        const obj = new TaskSQL();

        expect(obj.mailboxUid).toBe("");
        expect(obj.folderUid).toBe("");
        expect(obj.title).toBe("");
        expect(obj.body).toBeUndefined();
        expect(obj.dueDate).toBeUndefined();
        expect(obj.completed).toBe(false);
        expect(obj.priority).toBe(TaskPriority.NORMAL);
        expect(obj.reminderDate).toBeUndefined();
    });

    it("TaskSQL applies provided overrides when constructed with data.", () => {
        const dueDate = new Date("2026-04-01T00:00:00Z");
        const reminderDate = new Date("2026-03-31T00:00:00Z");
        const obj = new TaskSQL({
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

    it("NoteSQL falls back to class defaults when constructed with no data.", () => {
        const obj = new NoteSQL();

        expect(obj.mailboxUid).toBe("");
        expect(obj.folderUid).toBe("");
        expect(obj.title).toBe("");
        expect(obj.body).toBe("");
        expect(obj.color).toBeUndefined();
    });

    it("NoteSQL applies provided overrides when constructed with data.", () => {
        const obj = new NoteSQL({
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

    it("ScanResultSQL falls back to class defaults when constructed with no data.", () => {
        const obj = new ScanResultSQL();

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

    it("ScanResultSQL applies provided overrides when constructed with data.", () => {
        const scannedAt = new Date("2026-02-01T00:00:00Z");
        const obj = new ScanResultSQL({
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

    it("ScanResultSQL preserves class defaults for fields omitted from a partial override object.", () => {
        const obj = new ScanResultSQL({});

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

    it("QuarantineEntrySQL falls back to class defaults when constructed with no data.", () => {
        const obj = new QuarantineEntrySQL();

        expect(obj.mailboxUid).toBe("");
        expect(obj.originalMessageUid).toBeUndefined();
        expect(obj.reason).toBe(QuarantineReason.OTHER);
        expect(obj.scanResultUid).toBe("");
        expect(obj.rawBlobKey).toBe("");
        expect(obj.releasedAt).toBeUndefined();
        expect(obj.releasedByUserUid).toBeUndefined();
    });

    it("QuarantineEntrySQL applies provided overrides when constructed with data.", () => {
        const releasedAt = new Date("2026-05-01T00:00:00Z");
        const obj = new QuarantineEntrySQL({
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

    it("QuarantineEntrySQL preserves class defaults for fields omitted from a partial override object.", () => {
        const obj = new QuarantineEntrySQL({});

        expect(obj.mailboxUid).toBe("");
        expect(obj.originalMessageUid).toBeUndefined();
        expect(obj.reason).toBe(QuarantineReason.OTHER);
        expect(obj.scanResultUid).toBe("");
        expect(obj.rawBlobKey).toBe("");
        expect(obj.releasedAt).toBeUndefined();
        expect(obj.releasedByUserUid).toBeUndefined();
    });

    it("SearchIndexStateSQL falls back to class defaults when constructed with no data.", () => {
        const obj = new SearchIndexStateSQL();

        expect(obj.entityType).toBe("");
        expect(obj.entityUid).toBe("");
        expect(obj.provider).toBe("");
        expect(obj.indexedAt).toBeInstanceOf(Date);
        expect(obj.contentHash).toBe("");
    });

    it("SearchIndexStateSQL applies provided overrides when constructed with data.", () => {
        const indexedAt = new Date("2026-01-15T00:00:00Z");
        const obj = new SearchIndexStateSQL({
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

    it("SearchIndexStateSQL preserves class defaults for fields omitted from a partial override object.", () => {
        const obj = new SearchIndexStateSQL({});

        expect(obj.entityType).toBe("");
        expect(obj.entityUid).toBe("");
        expect(obj.provider).toBe("");
        expect(obj.indexedAt).toBeInstanceOf(Date);
        expect(obj.contentHash).toBe("");
    });

    it("IngestQueueEntrySQL falls back to class defaults when constructed with no data.", () => {
        const obj = new IngestQueueEntrySQL();

        expect(obj.mailboxUid).toBe("");
        expect(obj.envelopeFrom).toBe("");
        expect(obj.envelopeTo).toEqual([]);
        expect(obj.rawBlobKey).toBe("");
        expect(obj.status).toBe(IngestStatus.PENDING);
        expect(obj.errorMessage).toBeUndefined();
        expect(obj.quarantineReason).toBeUndefined();
    });

    it("IngestQueueEntrySQL applies provided overrides when constructed with data.", () => {
        const obj = new IngestQueueEntrySQL({
            mailboxUid: "mailbox-1",
            envelopeFrom: "sender@example.com",
            envelopeTo: ["recipient@example.com"],
            rawBlobKey: "blob-1",
            status: IngestStatus.FAILED,
            errorMessage: "parse error",
            quarantineReason: QuarantineReason.TRANSPORT_RULE,
        });

        expect(obj.mailboxUid).toBe("mailbox-1");
        expect(obj.envelopeFrom).toBe("sender@example.com");
        expect(obj.envelopeTo).toEqual(["recipient@example.com"]);
        expect(obj.rawBlobKey).toBe("blob-1");
        expect(obj.status).toBe(IngestStatus.FAILED);
        expect(obj.errorMessage).toBe("parse error");
        expect(obj.quarantineReason).toBe(QuarantineReason.TRANSPORT_RULE);
    });

    it("IngestQueueEntrySQL preserves class defaults for fields omitted from a partial override object.", () => {
        const obj = new IngestQueueEntrySQL({});

        expect(obj.mailboxUid).toBe("");
        expect(obj.envelopeFrom).toBe("");
        expect(obj.envelopeTo).toEqual([]);
        expect(obj.rawBlobKey).toBe("");
        expect(obj.status).toBe(IngestStatus.PENDING);
        expect(obj.errorMessage).toBeUndefined();
        expect(obj.quarantineReason).toBeUndefined();
    });

    it("TransportRuleSQL falls back to class defaults when constructed with no data.", () => {
        const obj = new TransportRuleSQL();

        expect(obj.name).toBe("");
        expect(obj.enabled).toBe(true);
        expect(obj.sequence).toBe(0);
        expect(obj.stopProcessingRules).toBe(false);
        expect(obj.conditions).toEqual({});
        expect(obj.actions).toEqual([]);
    });

    it("TransportRuleSQL applies provided overrides when constructed with data.", () => {
        const obj = new TransportRuleSQL({
            name: "Block competitor mentions",
            enabled: false,
            sequence: 5,
            stopProcessingRules: true,
            conditions: { subjectContains: ["confidential"] },
            actions: [{ type: TransportRuleActionType.REJECT }],
        });

        expect(obj.name).toBe("Block competitor mentions");
        expect(obj.enabled).toBe(false);
        expect(obj.sequence).toBe(5);
        expect(obj.stopProcessingRules).toBe(true);
        expect(obj.conditions).toEqual({ subjectContains: ["confidential"] });
        expect(obj.actions).toEqual([{ type: TransportRuleActionType.REJECT }]);
    });

    it("AuditLogEntrySQL falls back to class defaults when constructed with no data.", () => {
        const obj = new AuditLogEntrySQL();

        expect(obj.mailboxUid).toBeUndefined();
        expect(obj.actorUserUid).toBeUndefined();
        expect(obj.action).toBe(AuditAction.MAILBOX_CREATE);
        expect(obj.targetType).toBe("");
        expect(obj.targetUid).toBe("");
        expect(obj.ip).toBeUndefined();
        expect(obj.details).toBeUndefined();
    });

    it("AuditLogEntrySQL applies provided overrides when constructed with data.", () => {
        const obj = new AuditLogEntrySQL({
            mailboxUid: "mbx-1",
            actorUserUid: "user-1",
            action: AuditAction.MESSAGE_DELETE,
            targetType: "Message",
            targetUid: "msg-1",
            ip: "203.0.113.5",
            details: { subject: "Hello" },
        });

        expect(obj.mailboxUid).toBe("mbx-1");
        expect(obj.actorUserUid).toBe("user-1");
        expect(obj.action).toBe(AuditAction.MESSAGE_DELETE);
        expect(obj.targetType).toBe("Message");
        expect(obj.targetUid).toBe("msg-1");
        expect(obj.ip).toBe("203.0.113.5");
        expect(obj.details).toEqual({ subject: "Hello" });
    });

    it("AuditLogEntrySQL keeps class defaults for fields omitted from a partial constructor object.", () => {
        const obj = new AuditLogEntrySQL({ mailboxUid: "mbx-2" });

        expect(obj.mailboxUid).toBe("mbx-2");
        expect(obj.action).toBe(AuditAction.MAILBOX_CREATE);
        expect(obj.targetType).toBe("");
        expect(obj.targetUid).toBe("");
    });
});
