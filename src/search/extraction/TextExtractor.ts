///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/**
 * Extracts plain text content from a single attachment's binary content, for full-text search indexing (see
 * `SearchProvider`). Dispatched by MIME type via `ExtractorRegistry`. Runs as part of `AttachmentExtractionJob`
 * (a background job), never inline on message ingestion — extraction can be slow and must not block SMTP-ACK
 * or webmail send/save-draft latency.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface TextExtractor {
    /** The MIME types this extractor handles, e.g. `["application/pdf"]`. */
    readonly mimeTypes: string[];

    /**
     * Extracts plain text from `content`. Returns an empty string if no extractable text is found. Throws only
     * for content that cannot be parsed at all (e.g. corrupt file) — an empty result is not an error.
     */
    extract(content: Buffer): Promise<string>;
}
