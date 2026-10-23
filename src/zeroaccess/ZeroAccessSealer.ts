///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Encryption to a mailbox's zero-access key (`specs/search.md` §3): the one place this server encrypts anything for a
 * mailbox. Every artifact is a CMS `EnvelopedData` (ECDH P-256 key agreement, AES-256-GCM content encryption) built with
 * pkijs exactly as web-client's `lib/crypto/smime.ts` `encryptForRecipients()` builds an end-to-end message, so the client's
 * existing `decryptEnvelopedDataWithKeys()` opens all of them and a stored message is ordinary S/MIME any mail client holding
 * the key can read. The server encrypts with the certificate's public key only and never holds anything that decrypts.
 */
import { webcrypto } from "node:crypto";
import { promisify } from "node:util";
import { gzip as gzipCallback } from "node:zlib";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import type { SealedEventFields, ZeroAccessIndexDocument, ZeroAccessSummary } from "../models/types.js";

const gzip = promisify(gzipCallback);

/** pkijs on Node's WebCrypto, passed to each call rather than installed as pkijs's global engine. pkijs's `CryptoEngine`
 * class doesn't satisfy its own `ICryptoEngine` type (see web-client's `smime.ts`), hence the cast; it works at runtime. */
const ENGINE = new pkijs.CryptoEngine({ name: "rapidmx-zero-access", crypto: webcrypto as unknown as Crypto }) as unknown as pkijs.ICryptoEngine;

/** AES-256-GCM, the content encryption web-client accepts (it refuses non-AEAD `EnvelopedData` outright). */
const CONTENT_ENCRYPTION_ALGORITHM: AesKeyGenParams = { name: "AES-GCM", length: 256 };

/** Outer headers a zero-access message keeps in the clear: what the server stores in plaintext on the message row anyway
 * (`from`, `recipients`, threading, dates), so a mail client lists and threads it before decrypting. The subject is not
 * among them - it is replaced by `[...]`, RFC 9788's placeholder for a protected subject. */
const OUTER_HEADERS: ReadonlySet<string> = new Set(["from", "sender", "to", "cc", "reply-to", "date", "message-id", "in-reply-to", "references"]);

/** The subject an encrypted message shows outside its encryption (RFC 9788 §3.2). */
export const PROTECTED_SUBJECT = "[...]";

/** The MIME type a zero-access message's body has - also how a reader recognizes one without consulting the row. */
export const ZERO_ACCESS_CONTENT_TYPE = 'application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function parseCertificate(certDer: Uint8Array): pkijs.Certificate {
    const asn1 = asn1js.fromBER(toArrayBuffer(certDer));
    if (asn1.offset === -1) {
        throw new Error("Could not parse the zero-access certificate as DER.");
    }
    return new pkijs.Certificate({ schema: asn1.result });
}

/** `content` as a DER CMS `ContentInfo` holding an `EnvelopedData` addressed to the certificate `certDer`. */
export async function sealToCertificate(content: Uint8Array, certDer: Uint8Array): Promise<Buffer> {
    const envelopedData = new pkijs.EnvelopedData();
    envelopedData.addRecipientByCertificate(parseCertificate(certDer), undefined, undefined, ENGINE);
    await envelopedData.encrypt(CONTENT_ENCRYPTION_ALGORITHM, toArrayBuffer(content), ENGINE);
    const contentInfo = new pkijs.ContentInfo({ contentType: pkijs.ContentInfo.ENVELOPED_DATA, content: envelopedData.toSchema() });
    return Buffer.from(contentInfo.toSchema().toBER());
}

/** The sealed summary of a message (`MessageZeroAccess.sealedSummary`), base64. */
export async function sealSummary(summary: ZeroAccessSummary, certDer: Uint8Array): Promise<string> {
    const json: string = JSON.stringify({ subject: summary.subject, preview: summary.preview });
    return (await sealToCertificate(Buffer.from(json, "utf-8"), certDer)).toString("base64");
}

/** A calendar event's sealed content (`SealedEventContent.sealed`), base64 JSON of only the `SealedEventFields` that are set. */
export async function sealEventFields(fields: SealedEventFields, certDer: Uint8Array): Promise<string> {
    const json: string = JSON.stringify({
        title: fields.title,
        ...(fields.location !== undefined ? { location: fields.location } : {}),
        ...(fields.description !== undefined ? { description: fields.description } : {}),
        ...(fields.descriptionHtml !== undefined ? { descriptionHtml: fields.descriptionHtml } : {}),
    });
    return (await sealToCertificate(Buffer.from(json, "utf-8"), certDer)).toString("base64");
}

/** A sealed index entry (`ZeroAccessIndexEntry.sealed`), base64: the document gzipped, then encrypted. */
export async function sealIndexDocument(document: ZeroAccessIndexDocument, certDer: Uint8Array): Promise<string> {
    const compressed: Buffer = await gzip(Buffer.from(JSON.stringify(document), "utf-8"));
    return (await sealToCertificate(compressed, certDer)).toString("base64");
}

/** The header block of `raw` (everything before the first empty line), split into whole header fields - each with its
 * folded continuation lines - in their original form. */
function headerFields(raw: Buffer): string[] {
    const text: string = raw.toString("latin1");
    const end: number = text.search(/\r?\n\r?\n/);
    const lines: string[] = (end === -1 ? text : text.slice(0, end)).split(/\r?\n/);
    const fields: string[] = [];
    for (const line of lines) {
        if (/^[ \t]/.test(line) && fields.length > 0) {
            fields[fields.length - 1] += "\r\n" + line;
        } else if (line.length > 0) {
            fields.push(line);
        }
    }
    return fields;
}

/** Base64 wrapped at 76 characters per line, as RFC 2045 requires. */
function wrapBase64(bytes: Buffer): string {
    return (bytes.toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
}

/**
 * The stored form of a zero-access message: an S/MIME `enveloped-data` message whose encrypted content is the complete
 * original `raw` MIME - every header and byte, so a signed message still verifies after decryption - addressed to the
 * mailbox's zero-access certificate. The outer header block keeps `OUTER_HEADERS` from the original (byte for byte, folding
 * included) with `Subject: [...]`.
 */
export async function sealMessage(raw: Buffer, certDer: Uint8Array): Promise<Buffer> {
    const sealed: Buffer = await sealToCertificate(raw, certDer);
    const outer: string[] = headerFields(raw).filter((field) => OUTER_HEADERS.has(field.slice(0, field.indexOf(":")).trim().toLowerCase()));
    const header: string = [
        ...outer,
        `Subject: ${PROTECTED_SUBJECT}`,
        "MIME-Version: 1.0",
        `Content-Type: ${ZERO_ACCESS_CONTENT_TYPE}`,
        'Content-Disposition: attachment; filename="smime.p7m"',
        "Content-Transfer-Encoding: base64",
    ].join("\r\n");
    return Buffer.from(`${header}\r\n\r\n${wrapBase64(sealed)}\r\n`, "latin1");
}

/**
 * The ISO 8601 week (UTC) `date` falls in, as `YYYY-Www` - the index segment a message received then belongs to
 * (`specs/search.md` §7). The year is the ISO week-numbering year, which differs from the calendar year for a few days
 * around 1 January.
 */
export function isoWeekId(date: Date): string {
    const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    // The Thursday of this ISO week decides its year (weeks start on Monday; getUTCDay() has Sunday as 0).
    const weekday: number = day.getUTCDay() || 7;
    day.setUTCDate(day.getUTCDate() + 4 - weekday);
    const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
    const week: number = Math.ceil(((day.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
    return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
