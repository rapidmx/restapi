///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { importOptional } from "../../util/OptionalDeps.js";
import { TextExtractor } from "./TextExtractor.js";

/**
 * Extracts text from PDF attachment content via the optional peer dependency `pdf-parse`.
 *
 * @author Jean-Philippe Steinmetz
 */
export class PdfTextExtractor implements TextExtractor {
    public readonly mimeTypes: string[] = ["application/pdf"];

    public async extract(content: Buffer): Promise<string> {
        const pdfParse: any = await importOptional("pdf-parse");
        const parse = pdfParse.default ?? pdfParse;
        const result = await parse(content);
        return result.text ?? "";
    }
}
