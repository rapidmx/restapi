///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import type { Message } from "../models/types.js";
import { zeroAccessDraftBlobPrefix } from "../zeroaccess/ZeroAccessFiling.js";

/**
 * Draft bodies superseded under a legal hold (`Message.retainedBodyBlobKeys`).
 *
 * Every compose save writes a new body blob (`bodies/<uuid>`, or `za/<mailbox>/drafts/<uuid>` for a draft sealed in a
 * zero-access mailbox) and points the draft at it. Normally the replaced blob is
 * deleted; while the draft's mailbox is under a legal hold it must be kept instead, because the earlier content may be
 * discoverable. A kept blob that nothing references can't be exported or ever cleaned up, so the compose path records it
 * on the draft itself:
 * - compose (server `BaseMailComposeRoute`, and any protocol plugin replacing a draft body under a hold) appends the
 * replaced key with `withRetainedBodyBlobKey()` in the SAME version-checked update that sets the new `bodyBlobKey`;
 * - `MatterExportJob` exports each retained body of a custodian's in-range message as a `retainedDraftBody` line;
 * - `RetentionEnforcementJob` deletes retained blobs (when nothing else references them) and clears the field once no
 * open `Matter` holds the mailbox, on every run, whether or not a retention policy is set - and with the message when
 * it purges it. `ErasureExecutionJob` deletes them with an erased message.
 *
 * Only keys under `RETAINED_BODY_BLOB_KEY_PREFIX`, or under the draft's own mailbox's sealed draft prefix
 * (`zeroAccessDraftBlobPrefix(message.mailboxUid)`), are ever exported or deleted (`retainedBodyBlobKeysOf()`), so a
 * value that isn't a compose-created body can't point either job at another object in the blob store - nor at another
 * mailbox's sealed drafts.
 */

/** The only blob key prefix a retained body may have - the compose path's (and the protocol plugins' send handlers')
 * per-save body blobs. Those keys are minted fresh for one message and never shared with another row. */
export const RETAINED_BODY_BLOB_KEY_PREFIX = "bodies/";

/** The most superseded bodies one draft keeps: bounds the row (roughly 50 bytes per key - well under a Mongo document's
 * or a SQL `text` column's size) and the export. */
export const MAX_RETAINED_BODY_BLOB_KEYS = 500;

/** The fields of a draft the retained-body helpers read: its retained keys, and its mailbox (whose sealed draft prefix a
 * retained key may also have). */
export type RetainedBodyDraft = Pick<Message, "retainedBodyBlobKeys"> & Partial<Pick<Message, "mailboxUid">>;

/** The prefixes a retained body key of `message` may have: `RETAINED_BODY_BLOB_KEY_PREFIX`, and its mailbox's sealed draft
 * prefix when the row names a mailbox. */
function retainedBodyPrefixesOf(message: RetainedBodyDraft | undefined): string[] {
    const mailboxUid: unknown = message?.mailboxUid;
    return typeof mailboxUid === "string" && mailboxUid.length > 0 && !mailboxUid.includes("/")
        ? [RETAINED_BODY_BLOB_KEY_PREFIX, zeroAccessDraftBlobPrefix(mailboxUid)]
        : [RETAINED_BODY_BLOB_KEY_PREFIX];
}

/** Whether `key` is a body key `message` may retain: a string under one of `retainedBodyPrefixesOf(message)`, longer than it. */
function isRetainableBodyKey(message: RetainedBodyDraft | undefined, key: unknown): key is string {
    return typeof key === "string" && retainedBodyPrefixesOf(message).some((prefix) => key.length > prefix.length && key.startsWith(prefix));
}

/** `message`'s retained body blob keys that are well-formed (`RETAINED_BODY_BLOB_KEY_PREFIX` strings, or its own mailbox's
 * sealed draft keys), deduplicated in order. Anything else stored in the field is ignored. */
export function retainedBodyBlobKeysOf(message: RetainedBodyDraft | undefined): string[] {
    const stored: unknown = message?.retainedBodyBlobKeys;
    if (!Array.isArray(stored)) {
        return [];
    }
    const keys: string[] = stored.filter((key): key is string => isRetainableBodyKey(message, key));
    return [...new Set(keys)];
}

/**
 * The `retainedBodyBlobKeys` value to write when `replacedKey` - `message`'s current `bodyBlobKey` - is superseded while
 * the mailbox is under a legal hold: the existing list plus `replacedKey`. A key that isn't a `bodies/` key or a sealed draft
 * key of `message`'s mailbox, or one already listed, leaves the list as it is.
 *
 * @throws ApiError `409` when the draft already retains `MAX_RETAINED_BODY_BLOB_KEYS` bodies. Dropping one would lose
 * held content, so the save must be refused - the user can send the draft or start a new one.
 */
export function withRetainedBodyBlobKey(message: RetainedBodyDraft, replacedKey: string | undefined | null): string[] {
    const keys: string[] = retainedBodyBlobKeysOf(message);
    if (!isRetainableBodyKey(message, replacedKey) || keys.includes(replacedKey)) {
        return keys;
    }
    if (keys.length >= MAX_RETAINED_BODY_BLOB_KEYS) {
        throw new ApiError(
            ApiErrors.IDENTIFIER_EXISTS,
            409,
            "This draft has been saved too many times while its mailbox is under a legal hold - send it or start a new draft.",
        );
    }
    return [...keys, replacedKey];
}
