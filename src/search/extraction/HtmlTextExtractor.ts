///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { convert } from "html-to-text";
import { TextExtractor } from "./TextExtractor.js";

/**
 * Strips markup from HTML attachment/body content, keeping only its rendered text — used both for attachment
 * text extraction and to derive `Message.bodyPreview` from an HTML body.
 *
 * @author Jean-Philippe Steinmetz
 */
export class HtmlTextExtractor implements TextExtractor {
    public readonly mimeTypes: string[] = ["text/html"];

    public async extract(content: Buffer): Promise<string> {
        return convert(content.toString("utf-8"), { wordwrap: false });
    }
}
