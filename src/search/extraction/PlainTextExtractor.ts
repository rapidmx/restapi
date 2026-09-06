///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { TextExtractor } from "./TextExtractor.js";

/**
 * Passes plain-text attachment content through unchanged (decoded as UTF-8).
 *
 * @author Jean-Philippe Steinmetz
 */
export class PlainTextExtractor implements TextExtractor {
    public readonly mimeTypes: string[] = ["text/plain", "text/csv", "text/markdown"];

    public async extract(content: Buffer): Promise<string> {
        return content.toString("utf-8");
    }
}
