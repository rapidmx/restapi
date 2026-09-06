///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { DocxTextExtractor } from "./DocxTextExtractor.js";
import { HtmlTextExtractor } from "./HtmlTextExtractor.js";
import { PdfTextExtractor } from "./PdfTextExtractor.js";
import { PlainTextExtractor } from "./PlainTextExtractor.js";
import { TextExtractor } from "./TextExtractor.js";
const { Config, Logger } = ObjectDecorators;

/**
 * Dispatches attachment content to the `TextExtractor` registered for its MIME type, applying a size cap and
 * timeout so a single huge or pathological attachment cannot stall `AttachmentExtractionJob` indefinitely.
 *
 * @author Jean-Philippe Steinmetz
 */
export class ExtractorRegistry {
    @Config("mail:search:extraction:max_bytes", 25 * 1024 * 1024)
    private maxBytes: number = 25 * 1024 * 1024;

    @Config("mail:search:extraction:timeout_ms", 30_000)
    private timeoutMs: number = 30_000;

    @Logger
    private logger: any;

    private extractors: TextExtractor[] = [
        new PlainTextExtractor(),
        new HtmlTextExtractor(),
        new PdfTextExtractor(),
        new DocxTextExtractor(),
    ];

    private byMimeType: Map<string, TextExtractor> = new Map(
        this.extractors.flatMap((extractor) => extractor.mimeTypes.map((mimeType) => [mimeType, extractor])),
    );

    /**
     * Extracts text from `content` if a `TextExtractor` is registered for `mimeType` and `content` is within
     * the configured size cap, otherwise returns `undefined` without error (an unsupported/oversized
     * attachment simply isn't indexed by content — its filename is still searchable via the entity itself).
     */
    public async extract(mimeType: string, content: Buffer): Promise<string | undefined> {
        const extractor: TextExtractor | undefined = this.byMimeType.get(mimeType);
        if (!extractor) {
            return undefined;
        }

        if (content.length > this.maxBytes) {
            this.logger?.debug(`Skipping text extraction for ${mimeType}: content exceeds ${this.maxBytes} bytes.`);
            return undefined;
        }

        let timeoutHandle: NodeJS.Timeout | undefined;
        try {
            return await Promise.race([
                extractor.extract(content),
                new Promise<string>((_resolve, reject) => {
                    timeoutHandle = setTimeout(
                        () => reject(new Error(`Text extraction for ${mimeType} timed out after ${this.timeoutMs}ms.`)),
                        this.timeoutMs,
                    );
                }),
            ]);
        } catch (err: any) {
            this.logger?.warn(`Text extraction failed for ${mimeType}: ${err.message}`);
            return undefined;
        } finally {
            clearTimeout(timeoutHandle);
        }
    }
}
