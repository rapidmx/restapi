///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Field-by-field zero-access sealing of calendar events, contacts and tasks (`specs/search.md` §3 *What It Covers*). Each protected field
 * is sealed on its own - `sealedFields[name]`, base64 CMS `EnvelopedData` of the field's JSON value, addressed to the mailbox's
 * zero-access key - and its readable column holds a placeholder. Sealing per field, not as one blob, is what lets a partial update (a
 * phone changing only the time, a client adding a video link) replace only what it sends, and lets a device that round-trips a placeholder
 * leave the protected value alone, without the server ever being able to read what it keeps.
 *
 * The rule is mail's: the server may see plaintext inside a request, and never stores it while the type is protected.
 */
import type { ZeroAccessTarget } from "./ZeroAccessResolver.js";
import { sealToCertificate } from "./ZeroAccessSealer.js";

/** `sealedFields` of a record: protected field name -> base64 CMS of its JSON value. */
export type SealedFields = Record<string, string>;

/** One protected field of a data type. */
export interface ProtectedField<R = any> {
    name: string;
    /** What the readable column holds while the field is sealed, given the record as it will be stored (e.g. a contact's first email
     * address in place of its display name). */
    placeholder: (record: R) => unknown;
}

/** The placeholder text protected content shows where something must be shown (RFC 9788's protected subject). */
export const PROTECTED_TEXT = "[...]";

/** Whether `value` is the empty value of a field: absent, null, an empty string or an empty list. */
function isEmpty(value: unknown): boolean {
    return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

/** Whether `a` and `b` are the same JSON value. */
function sameValue(a: unknown, b: unknown): boolean {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Applies the protected `fields` of `patch` - a create or update body of a record whose type is protected when `target` is set - to what
 * will be stored, in place:
 *
 * - A field `patch` doesn't carry is left as it is (sealed or not).
 * - A field carrying the record's current placeholder while it is sealed is dropped from the patch: a device sent back what it was shown.
 * - With `target`: a field with a value is sealed into `sealedFields` and its column set to the placeholder; an empty one is stored
 * empty and its sealed copy removed.
 * - Without `target` (the type isn't protected, or no longer is): the value is stored readable and any sealed copy of the field
 * removed - a protected item becomes readable only when it is next edited, and only in the fields edited.
 *
 * `patch.sealedFields` is always set from `existing` and the result, never from the client: whatever the client sent there is replaced.
 */
export async function sealFieldsOnWrite<R extends { sealedFields?: SealedFields | null }>(
    patch: Record<string, any>,
    existing: R | undefined,
    fields: readonly ProtectedField<R>[],
    target: ZeroAccessTarget | undefined,
): Promise<void> {
    const sealed: SealedFields = { ...(existing?.sealedFields ?? {}) };
    const merged = { ...(existing ?? {}), ...patch } as unknown as R;
    for (const field of fields) {
        if (!(field.name in patch)) {
            continue;
        }
        const value: unknown = patch[field.name];
        if (sealed[field.name] !== undefined && existing && sameValue(value, field.placeholder(existing))) {
            delete patch[field.name];
            continue;
        }
        delete sealed[field.name];
        if (target && !isEmpty(value)) {
            sealed[field.name] = (await sealToCertificate(Buffer.from(JSON.stringify(value), "utf-8"), target.certDer)).toString("base64");
        }
    }
    // Placeholders last: one may depend on another field (a contact's name placeholder is its address).
    for (const field of fields) {
        if (field.name in patch && sealed[field.name] !== undefined) {
            patch[field.name] = field.placeholder(merged);
        }
    }
    patch.sealedFields = Object.keys(sealed).length > 0 ? sealed : null;
}

/** Whether any of `record`'s fields is sealed. */
export function hasSealedFields(record: { sealedFields?: SealedFields | null } | undefined): boolean {
    return !!record?.sealedFields && Object.keys(record.sealedFields).length > 0;
}
