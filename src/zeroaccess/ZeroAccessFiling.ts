///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { RepoUtils } from "@rapidrest/service-core";
import type { BlobStore } from "../blob/BlobStore.js";
import type { MessageZeroAccess, SealedEventContent, SealedEventFields, ZeroAccessIndexDocument, ZeroAccessIndexEntry, ZeroAccessSummary } from "../models/types.js";
import { nameBasedUuid } from "../util/UuidUtils.js";
import type { ZeroAccessTarget } from "./ZeroAccessResolver.js";
import { isoWeekId, sealEventFields, sealIndexDocument, sealMessage, sealSummary } from "./ZeroAccessSealer.js";

/** The blob a zero-access message's sealed MIME is stored under - one per filed message, never shared across mailboxes (each
 * mailbox's copy is sealed to its own key). */
export function zeroAccessBlobKey(mailboxUid: string, messageUid: string): string {
    return `za/${mailboxUid}/${messageUid}`;
}

/** The prefix of every saved draft body sealed for `mailboxUid`: a fresh key per save (`ZeroAccessWriter.sealDraft()`), like a
 * plaintext draft's `bodies/` keys, so a save never rewrites a body something may still be reading. */
export function zeroAccessDraftBlobPrefix(mailboxUid: string): string {
    return `za/${mailboxUid}/drafts/`;
}

/** The uid of a message's index entry - derived from the message, so a retried filing finds the one it already wrote. */
export function zeroAccessIndexEntryUid(messageUid: string): string {
    return nameBasedUuid(`za-index:${messageUid}`);
}

/**
 * Everything one zero-access filing writes, made once and reused across the message's copies (a mail filter rule's copies into
 * other folders share the sealed blob, as plaintext copies share the raw blob) and across a retried attempt (each write is
 * keyed by the message, and skipped when it already exists). Holds the plaintext only for as long as the delivery does.
 */
export class ZeroAccessFiling {
    private sealedBlobKey?: string;
    private summary?: string;

    constructor(
        public readonly target: ZeroAccessTarget,
        private readonly blobStore: BlobStore,
        private readonly mailboxUid: string,
    ) {}

    /** The fingerprint of the key everything is sealed to. */
    public get keyFingerprint(): string {
        return this.target.key.fingerprint;
    }

    /** Stores `raw` sealed (`sealMessage()`) under `blobKey` - by default `zeroAccessBlobKey(mailboxUid, messageUid)` - once, and returns
     * that key. */
    public async storeMessage(raw: Buffer, messageUid: string, blobKey?: string): Promise<string> {
        if (!this.sealedBlobKey) {
            const key: string = blobKey ?? zeroAccessBlobKey(this.mailboxUid, messageUid);
            if (!(await this.blobStore.exists(key))) {
                await this.blobStore.put(key, await sealMessage(raw, this.target.certDer), { contentType: "message/rfc822" });
            }
            this.sealedBlobKey = key;
        }
        return this.sealedBlobKey;
    }

    /** `Message.zeroAccess` for a message with this subject and preview (sealed once). */
    public async messageState(summary: ZeroAccessSummary): Promise<MessageZeroAccess> {
        this.summary ??= await sealSummary(summary, this.target.certDer);
        return { keyFingerprint: this.keyFingerprint, sealedSummary: this.summary };
    }

    /** `CalendarEvent.sealedContent` for an event with these fields. */
    public async eventContent(fields: SealedEventFields): Promise<SealedEventContent> {
        return { keyFingerprint: this.keyFingerprint, sealed: await sealEventFields(fields, this.target.certDer) };
    }

    /** Writes `messageUid`'s index entry from `document` unless it already exists - or, with `replace` (a draft saved again), in
     * place of the existing one. It goes in the week of `receivedAt` (`isoWeekId()`), or of now for a date no week can be named for -
     * one outside years 1000-9999, such as an imported message's odd `Date` header. */
    public async index(
        repo: RepoUtils<any>,
        entryClass: new (fields: Partial<ZeroAccessIndexEntry>) => ZeroAccessIndexEntry,
        messageUid: string,
        receivedAt: Date,
        document: Omit<ZeroAccessIndexDocument, "messageUid">,
        replace: boolean = false,
    ): Promise<void> {
        const uid: string = zeroAccessIndexEntryUid(messageUid);
        if (await repo.findOne(uid, { ignoreACL: true })) {
            if (!replace) {
                return;
            }
            await repo.delete(uid, { ignoreACL: true, purge: true });
        }
        const sealed: string = await sealIndexDocument({ ...document, messageUid }, this.target.certDer);
        const year: number = receivedAt.getUTCFullYear();
        const at: Date = year >= 1000 && year <= 9999 ? receivedAt : new Date();
        await repo.create(
            new entryClass({ uid, mailboxUid: this.mailboxUid, messageUid, weekId: isoWeekId(at), receivedAt: at, keyFingerprint: this.keyFingerprint, sealed }),
            { ignoreACL: true },
        );
    }
}
