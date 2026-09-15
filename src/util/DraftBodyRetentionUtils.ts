///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import type { Message } from "../models/types.js";

/**
 * Draft bodies superseded under a legal hold (`Message.retainedBodyBlobKeys`).
 *
 * Every compose save writes a new body blob (`bodies/<uuid>`) and points the draft at it. Normally the replaced blob is
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
 * Only keys under `RETAINED_BODY_BLOB_KEY_PREFIX` are ever exported or deleted (`retainedBodyBlobKeysOf()`), so a
 * value that isn't a compose-created body can't point either job at another object in the blob store.
 */

/** The only blob key prefix a retained body may have - the compose path's (and the protocol plugins' send handlers')
 * per-save body blobs. Those keys are minted fresh for one message and never shared with another row. */
export const RETAINED_BODY_BLOB_KEY_PREFIX = "bodies/";

/** The most superseded bodies one draft keeps: bounds the row (roughly 50 bytes per key - well under a Mongo document's
 * or a SQL `text` column's size) and the export. */
export const MAX_RETAINED_BODY_BLOB_KEYS = 500;

/** `message`'s retained body blob keys that are well-formed (`RETAINED_BODY_BLOB_KEY_PREFIX` strings), deduplicated in
 * order. Anything else stored in the field is ignored. */
export function retainedBodyBlobKeysOf(message: Pick<Message, "retainedBodyBlobKeys"> | undefined): string[] {
    const stored: unknown = message?.retainedBodyBlobKeys;
    if (!Array.isArray(stored)) {
        return [];
    }
    const keys: string[] = stored.filter(
        (key): key is string => typeof key === "string" && key.length > RETAINED_BODY_BLOB_KEY_PREFIX.length && key.startsWith(RETAINED_BODY_BLOB_KEY_PREFIX),
    );
    return [...new Set(keys)];
}

/**
 * The `retainedBodyBlobKeys` value to write when `replacedKey` - `message`'s current `bodyBlobKey` - is superseded while
 * the mailbox is under a legal hold: the existing list plus `replacedKey`. A key without the body prefix, or one already
 * listed, leaves the list as it is.
 *
 * @throws ApiError `409` when the draft already retains `MAX_RETAINED_BODY_BLOB_KEYS` bodies. Dropping one would lose
 * held content, so the save must be refused - the user can send the draft or start a new one.
 */
export function withRetainedBodyBlobKey(message: Pick<Message, "retainedBodyBlobKeys">, replacedKey: string | undefined | null): string[] {
    const keys: string[] = retainedBodyBlobKeysOf(message);
    if (typeof replacedKey !== "string" || !replacedKey.startsWith(RETAINED_BODY_BLOB_KEY_PREFIX) || keys.includes(replacedKey)) {
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
