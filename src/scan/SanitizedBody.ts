///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { BlobStore } from "../blob/BlobStore.js";
import { readSanitizerVersion, resolveInlineImages, SANITIZER_VERSION, stripSanitizerStamp } from "./HtmlSanitizer.js";
import type { ScanPipeline } from "./ScanPipeline.js";

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
 * or the new one, never a mix. The blob is only rewritten while it still exists, so a message erased meanwhile is not brought back.
 *
 * *Bounded.* A raw message over `maxRawBytes` is not re-parsed, and a run that takes over `timeoutMs` is left to finish in the
 * background while the reader is answered with what is stored.
 *
 * *Never worse than before.* Any failure (a missing raw blob, a parse error) serves the HTML already stored, and is not retried for
 * `RETRY_AFTER_MS`, so a message that cannot be redone costs one failed attempt, not one per read.
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
}

export interface SanitizedBodyOptions {
    /** A raw message larger than this many bytes is not re-parsed. */
    maxRawBytes: number;
    /** How long a reader waits for a re-sanitization before being served the stored HTML. */
    timeoutMs: number;
}

export class SanitizedBodyLoader {
    private readonly running: Map<string, Promise<string | undefined>> = new Map();
    private readonly failed: Map<string, number> = new Map();

    public constructor(
        private readonly blobStore: BlobStore,
        private readonly pipeline: ScanPipeline,
        private readonly options: SanitizedBodyOptions,
        private readonly logger?: { warn: (...args: any[]) => void },
    ) {}

    /** The message's sanitized HTML, current and without its version stamp. */
    public async load(message: SanitizedBodySource): Promise<string> {
        const stored: Buffer = await this.blobStore.get(message.sanitizedHtmlBlobKey);
        if (readSanitizerVersion(stored) >= SANITIZER_VERSION) {
            return stripSanitizerStamp(stored.toString("utf-8"));
        }
        const fresh: string | undefined = await this.refresh(message);
        return stripSanitizerStamp(fresh ?? stored.toString("utf-8"));
    }

    /** The re-sanitized HTML (stamped), or `undefined` when the stored HTML has to do. */
    private async refresh(message: SanitizedBodySource): Promise<string | undefined> {
        const key: string = message.sanitizedHtmlBlobKey;
        if ((this.failed.get(key) ?? 0) > Date.now()) {
            return undefined;
        }
        let run: Promise<string | undefined> | undefined = this.running.get(key);
        if (!run) {
            run = this.rebuild(message).finally(() => this.running.delete(key));
            this.running.set(key, run);
        }
        let timer: NodeJS.Timeout | undefined;
        const timeout: Promise<undefined> = new Promise((resolve) => {
            timer = setTimeout(() => resolve(undefined), this.options.timeoutMs);
        });
        try {
            return await Promise.race([run, timeout]);
        } finally {
            clearTimeout(timer);
        }
    }

    /** Never rejects: whatever goes wrong is a failure to remember, not an error for the reader. */
    private async rebuild(message: SanitizedBodySource): Promise<string | undefined> {
        const key: string = message.sanitizedHtmlBlobKey;
        try {
            if (!message.bodyBlobKey || (await this.blobStore.size(message.bodyBlobKey)) > this.options.maxRawBytes) {
                return this.giveUp(key);
            }
            const html: string | undefined = await this.pipeline.sanitizeRaw(await this.blobStore.get(message.bodyBlobKey));
            // Only an existing blob is replaced: one deleted while this ran (an erasure) stays deleted.
            if (html === undefined || !(await this.blobStore.exists(key))) {
                return this.giveUp(key);
            }
            await this.blobStore.put(key, Buffer.from(html, "utf-8"), { contentType: "text/html" });
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
