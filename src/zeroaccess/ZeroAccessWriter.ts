///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { ACLUtils, type ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { simpleParser, type ParsedMail } from "mailparser";
import type { BlobStore } from "../blob/BlobStore.js";
import type { Mailbox, MessageZeroAccess, Recipient } from "../models/types.js";
import { htmlPreview } from "../scan/HtmlPreview.js";
import { ExtractorRegistry } from "../search/extraction/ExtractorRegistry.js";
import { deleteBlobsIfUnreferenced, messageBlobReferenceSources, type MessageBlobRepos } from "../util/BlobReferenceUtils.js";
import { findPagesByUid } from "../util/MailboxContentUtils.js";
import { parseHeaderRecipients } from "../util/RecipientUtils.js";
import { ZeroAccessFiling, zeroAccessIndexEntryUid } from "./ZeroAccessFiling.js";
import { buildIndexDocument, type IndexableAttachment } from "./ZeroAccessIndexing.js";
import { ZeroAccessResolver, type ZeroAccessMailbox, type ZeroAccessTarget } from "./ZeroAccessResolver.js";
import { PROTECTED_SUBJECT } from "./ZeroAccessSealer.js";
const { Config, Inject } = ObjectDecorators;

/** How much of a body becomes a sealed message's preview - the same length delivery's `bodyPreview` has. */
const PREVIEW_MAX_LENGTH = 500;
/** How much of a body is indexed - `ScanPipeline`'s `BODY_TEXT_MAX_LENGTH`. */
const BODY_TEXT_MAX_LENGTH = 1_000_000;

/** The plaintext a filing knows about the message it seals - see `ZeroAccessWriter.seal()`. */
export interface ZeroAccessSealInput {
    /** The uid the `Message` row has (or will have): the sealed blob and the index entry are keyed by it. */
    messageUid: string;
    /** When the message was received or filed - its index entry's week. */
    receivedAt: Date;
    raw: Buffer;
    subject: string;
    preview: string;
    bodyText: string;
    fromAddress: string;
    fromDisplayName?: string;
    recipients: Recipient[];
    attachments: IndexableAttachment[];
}

/** The `Message` fields a sealed filing stores in place of the plaintext ones. */
export interface ZeroAccessSealedFields {
    subject: string;
    bodyPreview: string;
    bodyBlobKey: string;
    zeroAccess: MessageZeroAccess;
    /** The index entry written for the message, so a caller can remove it again if its filing fails. */
    indexEntryUid: string;
}

/**
 * Seals a message any writer other than inbound delivery files for a mailbox - a Sent Items copy, an import, a draft, a plugin's
 * message (restapi `specs/search.md` §3: no plaintext at rest for a zero-access mailbox, on any write path). One per backend, built
 * through the `ObjectFactory` with that backend's `EncryptionPolicy` and `ZeroAccessIndexEntry` repos; everything else is injected.
 * Inbound delivery (`ScanQueueJob`) uses `ZeroAccessFiling` directly, since it shares one sealed blob across a message's rule copies.
 */
export class ZeroAccessWriter {
    @Inject("BlobStore")
    protected blobStore?: BlobStore;

    @Inject(ACLUtils)
    protected aclUtils?: ACLUtils;

    @Inject(ExtractorRegistry)
    protected extractorRegistry?: ExtractorRegistry;

    @Config("trusted_roles", ["admin"])
    protected trustedRoles: string[] = ["admin"];

    @Config("mail:zero_access:allowed", true)
    protected allowedDefault: boolean = true;

    @Config("mail:zero_access:extraction_budget_ms", 5000)
    protected extractionBudgetMs: number = 5000;

    @Config("mail:zero_access:extraction_max_bytes", 10 * 1024 * 1024)
    protected extractionMaxBytes: number = 10 * 1024 * 1024;

    constructor(
        protected readonly policyRepo: RepoUtils<any> | undefined,
        protected readonly indexEntryRepo: RepoUtils<any> | undefined,
        protected readonly indexEntryClass: any,
    ) {}

    /** The key `mailbox`'s mail is sealed to now, or `undefined` when zero-access isn't active for it. */
    public async target(mailbox: ZeroAccessMailbox): Promise<ZeroAccessTarget | undefined> {
        return new ZeroAccessResolver(this.policyRepo, this.aclUtils, this.allowedDefault, this.trustedRoles).target(mailbox);
    }

    /**
     * Seals `input.raw` for `mailbox` when zero-access is active for it: stores the S/MIME message, writes its index entry, and returns
     * the fields its `Message` row takes instead of the plaintext ones. `undefined` - store the message as before - when it isn't.
     */
    public async seal(mailbox: Pick<Mailbox, "uid"> & ZeroAccessMailbox, input: ZeroAccessSealInput): Promise<ZeroAccessSealedFields | undefined> {
        const target: ZeroAccessTarget | undefined = await this.target(mailbox);
        if (!target) {
            return undefined;
        }
        if (!this.blobStore || !this.indexEntryRepo) {
            throw new Error("Zero-access filing needs a BlobStore and the ZeroAccessIndexEntry model.");
        }
        const filing = new ZeroAccessFiling(target, this.blobStore, mailbox.uid);
        const bodyBlobKey: string = await filing.storeMessage(input.raw, input.messageUid);
        const zeroAccess: MessageZeroAccess = await filing.messageState({ subject: input.subject, preview: input.preview });
        const { messageUid: _unused, ...document } = await buildIndexDocument(
            {
                messageUid: input.messageUid,
                subject: input.subject,
                bodyText: input.bodyText,
                fromAddress: input.fromAddress,
                fromDisplayName: input.fromDisplayName,
                recipients: input.recipients,
                attachments: input.attachments,
                dateForSort: input.receivedAt,
            },
            async (mimeType, content) => this.extractorRegistry?.extract(mimeType, content),
            { budgetMs: this.extractionBudgetMs, maxAttachmentBytes: this.extractionMaxBytes },
        );
        await filing.index(this.indexEntryRepo, this.indexEntryClass, input.messageUid, input.receivedAt, document);
        return { subject: PROTECTED_SUBJECT, bodyPreview: "", bodyBlobKey, zeroAccess, indexEntryUid: zeroAccessIndexEntryUid(input.messageUid) };
    }

    /**
     * Removes what a message no longer needs in plaintext once it has been sealed (`seal()`/`sealRaw()`) and its row points at the sealed
     * blob: `blobKeys` (its former body, sanitized HTML...) and its attachment rows and their blobs - the attachments are inside the
     * sealed message, where the client reads them. A blob something else still names is kept.
     */
    public async discardPlaintext(repos: MessageBlobRepos, messageUid: string, blobKeys: (string | null | undefined)[]): Promise<void> {
        const keys: (string | null | undefined)[] = [...blobKeys];
        if (repos.attachmentRepo) {
            for await (const page of findPagesByUid<any>(repos.attachmentRepo, { messageUid })) {
                for (const attachment of page) {
                    keys.push(attachment.blobKey, attachment.extractedTextBlobKey);
                    await repos.attachmentRepo.delete(attachment.uid, { ignoreACL: true, purge: true });
                }
            }
        }
        await deleteBlobsIfUnreferenced(this.blobStore!, messageBlobReferenceSources(repos), keys);
    }

    /** Removes an index entry `seal()` wrote, for a caller whose filing failed after it (best effort is the caller's to decide). */
    public async removeIndexEntry(uid: string): Promise<void> {
        await this.indexEntryRepo?.delete(uid, { ignoreACL: true, purge: true });
    }

    /** `seal()` for a writer holding only the raw message: parses it here for the subject, preview, index text and attachments. */
    public async sealRaw(
        mailbox: Pick<Mailbox, "uid"> & ZeroAccessMailbox,
        raw: Buffer,
        messageUid: string,
        receivedAt: Date,
    ): Promise<ZeroAccessSealedFields | undefined> {
        if (!(await this.target(mailbox))) {
            return undefined;
        }
        const parsed: ParsedMail = await simpleParser(raw, { skipImageLinks: true });
        const bodyText: string = (parsed.text || (typeof parsed.html === "string" ? htmlPreview(parsed.html, BODY_TEXT_MAX_LENGTH) : "")).slice(0, BODY_TEXT_MAX_LENGTH);
        return this.seal(mailbox, {
            messageUid,
            receivedAt,
            raw,
            subject: parsed.subject ?? "",
            preview: bodyText.trim().slice(0, PREVIEW_MAX_LENGTH),
            bodyText,
            fromAddress: parsed.from?.value?.[0]?.address ?? "",
            fromDisplayName: parsed.from?.value?.[0]?.name || undefined,
            recipients: parseHeaderRecipients(parsed),
            attachments: (parsed.attachments ?? []).map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content })),
        });
    }
}

/**
 * The `ZeroAccessWriter` for a backend - one per `encryptionPolicyClass`, shared by every writer of that backend - or `undefined` when
 * either model class isn't supplied (zero-access isn't available, and everything is stored as before).
 */
export async function newZeroAccessWriter(
    objectFactory: ObjectFactory,
    encryptionPolicyClass: any,
    indexEntryClass: any,
): Promise<ZeroAccessWriter | undefined> {
    if (!encryptionPolicyClass || !indexEntryClass) {
        return undefined;
    }
    const policyRepo: RepoUtils<any> = await objectFactory.newInstance(RepoUtils, { name: encryptionPolicyClass.name, args: [encryptionPolicyClass] });
    const indexEntryRepo: RepoUtils<any> = await objectFactory.newInstance(RepoUtils, { name: indexEntryClass.name, args: [indexEntryClass] });
    return await objectFactory.newInstance(ZeroAccessWriter, {
        name: `ZeroAccessWriter:${encryptionPolicyClass.name}`,
        args: [policyRepo, indexEntryRepo, indexEntryClass],
    });
}
