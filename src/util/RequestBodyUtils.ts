///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";

/**
 * Guards for client-supplied create/update bodies before they reach `RepoUtils`.
 *
 * `RepoUtils.update()` on Mongo writes `$set: { ...body }`, so a body key is a MongoDB update path: `aliasAddresses.3`
 * or `receiptStatus.0.readAt` writes one element of an array or sub-document, past every check a route makes on the
 * top-level field (`aliasAddresses`, `keys`, `actions`, ...). A `$`-prefixed key is an update operator or an invalid
 * field name. `RepoUtils.create()` on Mongo saves with `replaceOne({ _id }, doc, { upsert: true })` whenever `_id` is
 * set, so a client `_id` replaces whichever document already has it - another mailbox's message, say.
 */

/** Prototype-pollution-shaped keys - not currently exploitable (every write path here uses object spread,
 * not `Object.assign`/direct property assignment onto a shared prototype), but flagged anyway as
 * defense-in-depth against this function's own documented contract ("never a plain field name") and against
 * a future write path that assigns onto an object literal without spreading first. */
const UNSAFE_PROTO_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** Whether `key` is a dotted path, starts with `$`, or is a prototype-pollution-shaped key (`__proto__`,
 * `constructor`, `prototype`) - never a plain field name. */
export function isPathKey(key: string): boolean {
    return key.includes(".") || key.startsWith("$") || UNSAFE_PROTO_KEYS.has(key);
}

/** Refuses (400) a body (or each element of an array body) with any top-level key that is a dotted path or starts
 * with `$`. Non-object values pass through unchanged. */
export function assertNoPathKeys(obj: unknown): void {
    if (Array.isArray(obj)) {
        for (const single of obj) {
            assertNoPathKeys(single);
        }
        return;
    }
    if (!obj || typeof obj !== "object") {
        return;
    }
    for (const key of Object.keys(obj)) {
        if (isPathKey(key)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'${key}' is not a valid field name.`);
        }
    }
}

/** Refuses (400) a `PUT /:id/:property` property name that is empty, a dotted path or starts with `$`. */
export function assertPlainPropertyName(name: unknown): void {
    if (typeof name !== "string" || name.length === 0 || isPathKey(name)) {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'${String(name)}' is not a valid field name.`);
    }
}

/** Fields `RepoUtils` owns on every entity; a client never sets them on create. */
export const ENTITY_MANAGED_CREATE_FIELDS = ["_id", "version", "dateCreated", "dateModified"] as const;

/**
 * Drops `_id`, `version`, `dateCreated`, `dateModified` and every dotted/`$` key from a create body (or each element of
 * an array body) in place - silently, so a client re-posting a fetched object still works. Returns `obj`.
 */
export function stripClientCreateFields<T>(obj: T): T {
    if (Array.isArray(obj)) {
        for (const single of obj) {
            stripClientCreateFields(single);
        }
        return obj;
    }
    if (!obj || typeof obj !== "object") {
        return obj;
    }
    for (const key of Object.keys(obj)) {
        if (isPathKey(key) || (ENTITY_MANAGED_CREATE_FIELDS as readonly string[]).includes(key)) {
            delete (obj as any)[key];
        }
    }
    return obj;
}

/** Drops a client `_id` from an update body in place (`RepoUtils.update()` copies the stored one for model instances;
 * this covers every other path). */
export function stripClientId(obj: unknown): void {
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        delete (obj as any)._id;
    }
}

/**
 * Whether `err` is a unique-index violation: a raw MongoDB (`E11000`) or SQL driver error, or the `IDENTIFIER_EXISTS`
 * 400 that `RepoUtils.create()`/`update()` map one to since service-core 2.1.0 (a clash on a record's identity during
 * an update is a 409 instead, which callers that retry already treat as a lost race).
 */
export function isDuplicateKeyError(err: any): boolean {
    if (!err) {
        return false;
    }
    if (err.code === ApiErrors.IDENTIFIER_EXISTS && err.status === 400) {
        return true;
    }
    if (err.code === 11000 || err.code === "23505" || err.code === "ER_DUP_ENTRY" || err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return true;
    }
    const message: string = String(err.message ?? "");
    return /E11000|duplicate key|UNIQUE constraint failed|Duplicate entry/i.test(message);
}
