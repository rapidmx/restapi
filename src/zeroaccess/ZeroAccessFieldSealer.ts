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

/** How `sealFieldsOnWrite()` reads a write. */
export interface SealFieldsOptions {
    /**
     * The sealed fields the writer clears: an empty value (`null`, `[]`) of one of these whose placeholder is empty is a clear, applied,
     * not a placeholder sent back. `true` names every field. Only a writer that opened the record can mean a clear, so it is named, never
     * inferred: a client that couldn't open the record (keys locked, a delegate without the key, a REST tool echoing what it read) sends
     * back the empty placeholders it was shown, exactly as a device (ActiveSync, MAPI) does, and those must leave the sealed values alone.
     * The REST routes take the list from the request (`ZeroAccessRouteSealing.seal()`, `clearedFields`). A non-empty placeholder ("Protected
     * task", a contact's first address) sent back is ignored either way.
     */
    emptyClears?: boolean | readonly string[];
}

/** Whether `options` names `name` as a field the writer clears. */
function clears(options: SealFieldsOptions, name: string): boolean {
    return options.emptyClears === true || (Array.isArray(options.emptyClears) && options.emptyClears.includes(name));
}

/**
 * Applies the protected `fields` of `patch` - a create or update body of a record whose type is protected when `target` is set - to what
 * will be stored, in place:
 *
 * - A field carrying the record's current placeholder while it is sealed is dropped from the patch: a device sent back what it was shown.
 * With `options.emptyClears` naming it, only a non-empty placeholder is: an empty value of a field with an empty placeholder clears it.
 * - With `target`: a field with a value is sealed into `sealedFields` and its column set to the placeholder; an empty one is stored
 * empty and its sealed copy removed. A field `patch` doesn't carry that `existing` still holds readable - the record wasn't sealed yet (the
 * backfill hadn't reached it, it moved here from a mailbox that doesn't protect the type, or the field was edited while the type was off) -
 * is sealed too: the first protected write of a record leaves none of it readable, whatever it carries. A record whose content is
 * sealed whole (an event's `sealedContent`) has only placeholders in those columns, and is left to its own sealing.
 * - Without `target` (the type isn't protected, or no longer is): the value is stored readable and any sealed copy of the field
 * removed - a protected item becomes readable only when it is next edited, and only in the fields edited. A field `patch` doesn't
 * carry is left as it is.
 *
 * `patch.sealedFields` is always set from `existing` and the result, never from the client: whatever the client sent there is replaced.
 */
export async function sealFieldsOnWrite<R extends { sealedFields?: SealedFields | null }>(
    patch: Record<string, any>,
    existing: R | undefined,
    fields: readonly ProtectedField<R>[],
    target: ZeroAccessTarget | undefined,
    options: SealFieldsOptions = {},
): Promise<void> {
    const sealed: SealedFields = { ...(existing?.sealedFields ?? {}) };
    const merged = { ...(existing ?? {}), ...patch } as unknown as R;
    // The fields `existing` still holds readable that the patch leaves alone, sealed with it once the type is protected.
    const unsealed: Set<string> = new Set();
    if (target && existing && !(existing as any).sealedContent) {
        for (const field of fields) {
            if (!(field.name in patch) && sealed[field.name] === undefined && !isEmpty((existing as any)[field.name])) {
                unsealed.add(field.name);
            }
        }
    }
    for (const field of fields) {
        if (!(field.name in patch) && !unsealed.has(field.name)) {
            continue;
        }
        const value: unknown = unsealed.has(field.name) ? (existing as any)[field.name] : patch[field.name];
        const placeholder: unknown = existing ? field.placeholder(existing) : undefined;
        if (sealed[field.name] !== undefined && existing && sameValue(value, placeholder) && !(clears(options, field.name) && isEmpty(placeholder))) {
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
        if ((field.name in patch || unsealed.has(field.name)) && sealed[field.name] !== undefined) {
            patch[field.name] = field.placeholder(merged);
        }
    }
    patch.sealedFields = Object.keys(sealed).length > 0 ? sealed : null;
}

/** Whether any of `record`'s fields is sealed. */
export function hasSealedFields(record: { sealedFields?: SealedFields | null } | undefined): boolean {
    return !!record?.sealedFields && Object.keys(record.sealedFields).length > 0;
}
