///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import type { BlobStore } from "../blob/BlobStore.js";
import { readSanitizerVersion, resolveInlineImages, SANITIZER_VERSION, stripSanitizerStamp } from "./HtmlSanitizer.js";
import { ScanPipeline } from "./ScanPipeline.js";
const { Config, Inject, Logger } = ObjectDecorators;

/**
 * Serving a message's sanitized HTML: the stored blob, brought up to date when the sanitizer that wrote it is older than the current
 * one, with its inline (`cid:`) images pointed at the message's attachments. What `GET /messages/:id/content` does with
 * `Message.sanitizedHtmlBlobKey`, kept here so the route only has to ask.
 *
 * **Lazy re-sanitization.** A message stored by an older sanitizer (the stamp `HtmlSanitizer.stampSanitizedHtml()` puts in front of every
 * blob is missing or lower than `SANITIZER_VERSION`) is sanitized again from its raw MIME (`bodyBlobKey`) the first time it is read - no
 * spam or virus scan, only the parse and the sanitize - and the blob is overwritten with the result, so every later read is a plain
 * blob read. There is no migration job: what is never opened is never redone.
 *
 * *Race-safe and idempotent.* Sanitizing is a pure function of the raw MIME, so concurrent readers (in this process: one shared
 * run per blob; in another: the same result) write the same bytes, and a blob store replaces atomically - a reader sees the old blob
 * or the new one, never a mix. The blob is only rewritten while it still exists, so a message erased meanwhile is not brought back, and
 * once rewritten it is deleted again unless the message still names it (`SanitizedBodySource.stillNamed`): zero-access sealing, a send's
 * discard and a user's purge change (or delete) the row before they delete the blob, so whichever of the two deletes comes last removes
 * it. An erasure (`ErasureExecutionJob`) and a retention purge (`RetentionEnforcementJob`) delete the blob first, so a failure leaves the
 * row to retry, and delete it once more after the row is gone - the same "last delete wins" then holds. That
 * delete keeps a key another message still names (`SanitizedBodySource.discard` - a mail-filter-rule copy shares its original's), and
 * when the check itself fails the blob is deleted all the same - it may be plaintext of a message sealed meanwhile - but this reader is
 * still served what was rewritten.
 *
 * *Missing blob.* A blob that is gone while the message, read just before, still names it (deleted by that failed check, or lost) is
 * redone from the raw MIME as above, without the "still exists" condition - the check after the write still removes it when the
 * message no longer names it. Only when that can't be done is the read's error passed on.
 *
 * *Bounded.* A raw message over `maxRawBytes` is not re-parsed, and a run that takes over `timeoutMs` is left to finish in the
 * background while the reader is answered with what is stored.
 *
 * *Fails closed.* Any failure (a missing raw blob, a parse error, a message too large) is not retried for `RETRY_AFTER_MS`, so a message
 * that cannot be redone costs one failed attempt, not one per read. What is served meanwhile is the stored HTML passed through the
 * current sanitizer too - never as an older sanitizer left it, which may have let through what the current one blocks - and nothing at
 * all if even that fails.
 *
 * @author Jean-Philippe Steinmetz
 */

/** How long a message that could not be re-sanitized is left alone. */
export const RETRY_AFTER_MS = 5 * 60 * 1000;
/** The most failed messages remembered. */
const MAX_FAILURES = 2000;

/** The part of a message the loader needs. */
export interface SanitizedBodySource {
    uid: string;
    bodyBlobKey?: string;
    sanitizedHtmlBlobKey: string;
    /** Whether the message, read again, is still readable and still names `sanitizedHtmlBlobKey`; asked after the blob is rewritten. */
    stillNamed?: () => Promise<boolean>;
    /** Deletes `sanitizedHtmlBlobKey` once the message no longer names it, unless another row still does. Without it (or when it
     * fails) the key is deleted outright. */
    discard?: () => Promise<void>;
}

export class SanitizedBodyLoader {
    private readonly running: Map<string, Promise<string | undefined>> = new Map();
    private readonly failed: Map<string, number> = new Map();

    @Inject("BlobStore")
    private blobStore!: BlobStore;

    @Inject(ScanPipeline)
    private pipeline!: ScanPipeline;

    /** A message stored by an older sanitizer is re-sanitized on first read unless its raw MIME is larger than this many bytes. */
    @Config("mail:scan:sanitize:lazy_max_raw_bytes", 16 * 1024 * 1024)
    private maxRawBytes: number = 16 * 1024 * 1024;

    /** How long a reader waits for a re-sanitization before being served the stored HTML. */
    @Config("mail:scan:sanitize:lazy_timeout_ms", 10_000)
    private timeoutMs: number = 10_000;

    @Logger
    private logger?: { warn: (...args: any[]) => void };

    /** The message's sanitized HTML, current and without its version stamp. */
    public async load(message: SanitizedBodySource): Promise<string> {
        let stored: Buffer;
        try {
            stored = await this.blobStore.get(message.sanitizedHtmlBlobKey);
        } catch (err) {
            // A store that can't tell is not a missing blob.
            if (await this.blobStore.exists(message.sanitizedHtmlBlobKey).catch(() => true)) {
                throw err;
            }
            const redone: string | undefined = await this.refresh(message, true);
            if (redone === undefined) {
                throw err;
            }
            return stripSanitizerStamp(redone);
        }
        if (readSanitizerVersion(stored) >= SANITIZER_VERSION) {
            return stripSanitizerStamp(stored.toString("utf-8"));
        }
        const fresh: string | undefined = await this.refresh(message);
        return stripSanitizerStamp(fresh ?? this.sanitizeStored(message, stored.toString("utf-8")));
    }

    /** The old blob's HTML sanitized by the current sanitizer, or an empty body when that cannot be done either. */
    private sanitizeStored(message: SanitizedBodySource, html: string): string {
        try {
            return this.pipeline.sanitizeStoredHtml(html);
        } catch (err) {
            this.logger?.warn(`Could not sanitize the stored HTML of message ${message.uid}, serving none: ${(err as Error).message}`);
            return "";
        }
    }

    /** The re-sanitized HTML (stamped), or `undefined` when it could not be redone from the raw message. */
    private async refresh(message: SanitizedBodySource, missing: boolean = false): Promise<string | undefined> {
        const key: string = message.sanitizedHtmlBlobKey;
        if ((this.failed.get(key) ?? 0) > Date.now()) {
            return undefined;
        }
        let run: Promise<string | undefined> | undefined = this.running.get(key);
        if (!run) {
            run = this.rebuild(message, missing).finally(() => this.running.delete(key));
            this.running.set(key, run);
        }
        let timer: NodeJS.Timeout | undefined;
        const timeout: Promise<undefined> = new Promise((resolve) => {
            timer = setTimeout(() => resolve(undefined), this.timeoutMs);
        });
        try {
            return await Promise.race([run, timeout]);
        } finally {
            clearTimeout(timer);
        }
    }

    /** Never rejects: whatever goes wrong is a failure to remember, not an error for the reader. `missing`: the blob is to be written
     * again although it no longer exists (`load()`). */
    private async rebuild(message: SanitizedBodySource, missing: boolean): Promise<string | undefined> {
        const key: string = message.sanitizedHtmlBlobKey;
        try {
            if (!message.bodyBlobKey || (await this.blobStore.size(message.bodyBlobKey)) > this.maxRawBytes) {
                return this.giveUp(key);
            }
            const html: string | undefined = await this.pipeline.sanitizeRaw(await this.blobStore.get(message.bodyBlobKey));
            // Only an existing blob is replaced: one deleted while this ran (an erasure) stays deleted.
            if (html === undefined || (!missing && !(await this.blobStore.exists(key)))) {
                return this.giveUp(key);
            }
            await this.blobStore.put(key, Buffer.from(html, "utf-8"), { contentType: "text/html" });
            if (!message.stillNamed) {
                return html;
            }
            let named: boolean;
            try {
                named = await message.stillNamed();
            } catch (err) {
                // Unknown: the row may have been sealed meanwhile, so the plaintext just written goes. Nothing is lost - the next read
                // redoes it while the message still names it (`load()`) - and this reader, who could read the message, gets it.
                this.logger?.warn(`Could not tell whether message ${message.uid} still names ${key}, deleting it: ${(err as Error).message}`);
                await this.blobStore.delete(key).catch(() => undefined);
                return html;
            }
            if (!named) {
                // Sealed, sent or erased while this ran, after the check above: the row dropped the key, so what was just written is
                // plaintext it no longer names, which nothing else would ever delete - unless another row (a rule copy) still names it.
                try {
                    await (message.discard ? message.discard() : this.blobStore.delete(key));
                } catch {
                    await this.blobStore.delete(key).catch(() => undefined);
                }
                return this.giveUp(key);
            }
            return html;
        } catch (err) {
            this.logger?.warn(`Could not re-sanitize message ${message.uid}, serving its stored HTML: ${(err as Error).message}`);
            return this.giveUp(key);
        }
    }

    private giveUp(key: string): undefined {
        if (this.failed.size >= MAX_FAILURES) {
            this.failed.delete(this.failed.keys().next().value as string);
        }
        this.failed.set(key, Date.now() + RETRY_AFTER_MS);
        return undefined;
    }
}

/** An attachment as far as inline images are concerned. */
export interface InlineAttachment {
    uid: string;
    contentId?: string;
}

/** How a `cid:` reference in the served HTML is written: `attachment` = the attachment's own URL, `keep` = left as `cid:` for a client that resolves it itself. */
export type InlineImageMode = "attachment" | "keep";

const unbracket = (contentId: string): string => contentId.trim().replace(/^<|>$/g, "");

/**
 * `html` with each `cid:` image pointed at the attachment whose `Content-ID` it names (`<prefix>/<attachment uid>/content`), or - in
 * `keep` mode - left as `cid:` when there is such an attachment. A reference to a part the message does not have loses its `src` (an
 * `<img>` keeps its `alt`), so nothing is left that can never load.
 */
export function pointInlineImages(html: string, attachments: InlineAttachment[], mode: InlineImageMode, urlPrefix: string): string {
    const exact: Map<string, InlineAttachment> = new Map();
    const lowerCase: Map<string, InlineAttachment> = new Map();
    for (const attachment of attachments) {
        if (attachment.contentId) {
            const id: string = unbracket(attachment.contentId);
            exact.set(id, attachment);
            lowerCase.set(id.toLowerCase(), attachment);
        }
    }
    return resolveInlineImages(html, (token: string) => {
        const attachment: InlineAttachment | undefined = exact.get(token) ?? lowerCase.get(token.toLowerCase());
        return attachment ? (mode === "keep" ? `cid:${token}` : `${urlPrefix.replace(/\/+$/, "")}/${encodeURIComponent(attachment.uid)}/content`) : undefined;
    });
}
