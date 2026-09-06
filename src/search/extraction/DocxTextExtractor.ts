///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { importOptional } from "../../util/OptionalDeps.js";
import { TextExtractor } from "./TextExtractor.js";

/**
 * Extracts text from Word (`.docx`) attachment content via the optional peer dependency `mammoth`.
 *
 * Excel/PowerPoint (`.xlsx`/`.pptx`) are deliberately out of scope for the initial pragmatic subset — their
 * text is largely tabular/slide-fragmented and extracts poorly with a generic converter. Revisit with a
 * dedicated extractor if search relevance over spreadsheet/slide attachments becomes a real requirement.
 *
 * @author Jean-Philippe Steinmetz
 */
export class DocxTextExtractor implements TextExtractor {
    public readonly mimeTypes: string[] = [
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];

    public async extract(content: Buffer): Promise<string> {
        const mammoth: any = await importOptional("mammoth");
        const result = await mammoth.extractRawText({ buffer: content });
        return result.value ?? "";
    }
}
