///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { randomUUID } from "node:crypto";
import { ObjectDecorators } from "@rapidrest/core";
import { ACLUtils, type ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { simpleParser, type ParsedMail } from "mailparser";
import type { BlobStore } from "../blob/BlobStore.js";
import type { Mailbox, MessageZeroAccess, Recipient, ZeroAccessDataType } from "../models/types.js";
import { htmlPreview } from "../scan/HtmlPreview.js";
import { ExtractorRegistry } from "../search/extraction/ExtractorRegistry.js";
import { deleteBlobsIfUnreferenced, messageBlobReferenceSources, type MessageBlobRepos } from "../util/BlobReferenceUtils.js";
import { asEntity } from "../util/EntityUtils.js";
import { findPagesByUid } from "../util/MailboxContentUtils.js";
import { parseHeaderRecipients } from "../util/RecipientUtils.js";
import { ZeroAccessFiling, zeroAccessDraftBlobPrefix, zeroAccessIndexEntryUid } from "./ZeroAccessFiling.js";
import { buildIndexDocument, type IndexableAttachment } from "./ZeroAccessIndexing.js";
import { ZeroAccessResolver, type ZeroAccessMailbox, type ZeroAccessTarget } from "./ZeroAccessResolver.js";
import { PROTECTED_SUBJECT } from "./ZeroAccessSealer.js";
const { Config, Inject } = ObjectDecorators;

/** Why a draft stored sealed can't be relayed as it is: `POST /messages/:id/send` answers 409 with it, and `ScheduledSendJob` refuses a
 * queued draft with it. The client assembles the draft again for sending (`intent: "send"`), which stores it readable until relayed. */
export const ZERO_ACCESS_DRAFT_MESSAGE =
    "This draft is stored with zero-access encryption, which the server can't send. Open it and send it again.";

/** Where `seal()` stores the sealed message and how it treats an existing index entry - the defaults are a message filed once. */
export interface ZeroAccessSealOptions {
    /** The blob key to store the sealed message under, instead of `zeroAccessBlobKey(mailboxUid, messageUid)`. */
    blobKey?: string;
    /** Replace the message's index entry when it has one, instead of keeping it. */
    replaceIndexEntry?: boolean;
    /** Don't write the index entry: the caller writes it with the returned `writeIndex()` once its own write of the row has won, so a
     * seal that loses never touches the entry the winner wrote. */
    deferIndex?: boolean;
}

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
    /** With `deferIndex`: writes the index entry `seal()` left out (replacing one when `replaceIndexEntry` was set). */
    writeIndex?: () => Promise<void>;
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

    /** The key `mailbox`'s mail is sealed to now, or `undefined` when zero-access isn't active for it. `allowed`: the administrator's
     * setting already read (`allowed()`), for a caller deciding many mailboxes. */
    public async target(mailbox: ZeroAccessMailbox, type: ZeroAccessDataType = "mail", allowed?: boolean): Promise<ZeroAccessTarget | undefined> {
        return this.resolver().target(mailbox, type, allowed);
    }

    /** The effective "Allow zero-access encryption" (`ZeroAccessResolver.allowed()`). */
    public allowed(): Promise<boolean> {
        return this.resolver().allowed();
    }

    private resolver(): ZeroAccessResolver {
        return new ZeroAccessResolver(this.policyRepo, this.aclUtils, this.allowedDefault, this.trustedRoles);
    }

    /**
     * Seals `input.raw` for `mailbox` when zero-access is active for it: stores the S/MIME message, writes its index entry, and returns
     * the fields its `Message` row takes instead of the plaintext ones. `undefined` - store the message as before - when it isn't.
     */
    public async seal(
        mailbox: Pick<Mailbox, "uid"> & ZeroAccessMailbox,
        input: ZeroAccessSealInput,
        options: ZeroAccessSealOptions = {},
    ): Promise<ZeroAccessSealedFields | undefined> {
        const target: ZeroAccessTarget | undefined = await this.target(mailbox);
        if (!target) {
            return undefined;
        }
        if (!this.blobStore || !this.indexEntryRepo) {
            throw new Error("Zero-access filing needs a BlobStore and the ZeroAccessIndexEntry model.");
        }
        const filing = new ZeroAccessFiling(target, this.blobStore, mailbox.uid);
        const bodyBlobKey: string = await filing.storeMessage(input.raw, input.messageUid, options.blobKey);
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
        const indexEntryRepo: RepoUtils<any> = this.indexEntryRepo;
        const writeIndex = async (): Promise<void> =>
            await filing.index(indexEntryRepo, this.indexEntryClass, input.messageUid, input.receivedAt, document, options.replaceIndexEntry);
        const sealed: ZeroAccessSealedFields = { subject: PROTECTED_SUBJECT, bodyPreview: "", bodyBlobKey, zeroAccess, indexEntryUid: zeroAccessIndexEntryUid(input.messageUid) };
        if (options.deferIndex) {
            sealed.writeIndex = writeIndex;
        } else {
            await writeIndex();
        }
        return sealed;
    }

    /**
     * Removes what a message no longer needs in plaintext once it has been sealed (`seal()`/`sealRaw()`) and its row points at the sealed
     * blob: `blobKeys` (its former body, sanitized HTML...) and its attachment rows and their blobs - the attachments are inside the
     * sealed message, where the client reads them. A blob something else still names is kept. Never for a draft, whose attachment rows
     * are its working attachments (the compose window lists them, and its send builds the message from them): see
     * `discardDraftPlaintext()`.
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

    /**
     * `discardPlaintext()` for a draft just sealed (`sealDraft()`): removes `blobKeys` (its former body, sanitized HTML), but keeps its
     * attachment rows and their blobs, which are the draft's working attachments - readable until it is sent, as a sealed save keeps them.
     * Only their extracted text goes, a derivative nothing indexes while the draft is sealed: each row's `extractedTextBlobKey` is cleared
     * (version-checked; a row changed meanwhile keeps it) and its blob removed. `AttachmentExtractionJob` puts such a row off while the
     * draft stays sealed, and extracts it again once the draft is readable.
     */
    public async discardDraftPlaintext(repos: MessageBlobRepos, messageUid: string, blobKeys: (string | null | undefined)[]): Promise<void> {
        const keys: (string | null | undefined)[] = [...blobKeys];
        if (repos.attachmentRepo) {
            for await (const page of findPagesByUid<any>(repos.attachmentRepo, { messageUid })) {
                for (const attachment of page) {
                    if (!attachment.extractedTextBlobKey) {
                        continue;
                    }
                    try {
                        await repos.attachmentRepo.update(
                            { uid: attachment.uid, version: attachment.version, extractedTextBlobKey: null } as any,
                            asEntity(repos.attachmentRepo, attachment),
                            { ignoreACL: true },
                        );
                    } catch {
                        // Changed meanwhile: it keeps its text.
                        continue;
                    }
                    keys.push(attachment.extractedTextBlobKey);
                }
            }
        }
        await deleteBlobsIfUnreferenced(this.blobStore!, messageBlobReferenceSources(repos), keys);
    }

    /** Removes an index entry `seal()` wrote, for a caller whose filing failed after it (best effort is the caller's to decide). */
    public async removeIndexEntry(uid: string): Promise<void> {
        await this.indexEntryRepo?.delete(uid, { ignoreACL: true, purge: true });
    }

    /**
     * `seal()` for a writer holding only the raw message: parses it here for the subject, preview, index text and attachments. The
     * parse only feeds those - sealing needs nothing but the bytes - so a message mailparser can't read is still sealed whole, with an
     * empty summary and nothing indexed, never left readable. The HTML is converted by the bounded `htmlPreview()`: mailparser's own
     * conversion fails on deeply nested HTML (about 3000 `<div>`s), as `ScanPipeline` and the transport rules found.
     */
    public async sealRaw(
        mailbox: Pick<Mailbox, "uid"> & ZeroAccessMailbox,
        raw: Buffer,
        messageUid: string,
        receivedAt: Date,
        options: ZeroAccessSealOptions = {},
    ): Promise<ZeroAccessSealedFields | undefined> {
        if (!(await this.target(mailbox))) {
            return undefined;
        }
        let parsed: ParsedMail | undefined;
        try {
            parsed = await simpleParser(raw, { skipImageLinks: true, skipHtmlToText: true });
        } catch {
            parsed = undefined;
        }
        // With `skipHtmlToText`, an HTML-only message's `text` is "", not undefined.
        const bodyText: string = (parsed?.text || (typeof parsed?.html === "string" ? htmlPreview(parsed.html, BODY_TEXT_MAX_LENGTH) : "")).slice(0, BODY_TEXT_MAX_LENGTH);
        return this.seal(mailbox, {
            messageUid,
            receivedAt,
            raw,
            subject: parsed?.subject ?? "",
            preview: bodyText.trim().slice(0, PREVIEW_MAX_LENGTH),
            bodyText,
            fromAddress: parsed?.from?.value?.[0]?.address ?? "",
            fromDisplayName: parsed?.from?.value?.[0]?.name || undefined,
            recipients: parsed ? parseHeaderRecipients(parsed) : [],
            attachments: (parsed?.attachments ?? []).map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content })),
        }, options);
    }

    /**
     * Seals a saved draft's composed MIME for `mailbox` when zero-access is active for it (`undefined` when it isn't): to a fresh blob
     * under `zeroAccessDraftBlobPrefix()` each save, with the draft's index entry replaced. The caller points the draft at the returned
     * `bodyBlobKey` and removes the body it replaces, as it does for a plaintext save. `deferIndex`: see `ZeroAccessSealOptions`.
     */
    public async sealDraft(
        mailbox: Pick<Mailbox, "uid"> & ZeroAccessMailbox,
        raw: Buffer,
        messageUid: string,
        savedAt: Date,
        options: Pick<ZeroAccessSealOptions, "deferIndex"> = {},
    ): Promise<ZeroAccessSealedFields | undefined> {
        return this.sealRaw(mailbox, raw, messageUid, savedAt, {
            blobKey: `${zeroAccessDraftBlobPrefix(mailbox.uid)}${randomUUID()}`,
            replaceIndexEntry: true,
            deferIndex: options.deferIndex,
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
