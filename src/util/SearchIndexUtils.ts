///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { SearchEntityType, SearchProvider } from "../search/SearchProvider.js";

/**
 * Removes documents from the full-text search index after their entities were purged from the primary datastore.
 *
 * Every hard-delete/purge path (erasure, retention, quarantine retention, recall, route deletes/truncates) must call
 * this, otherwise the provider keeps serving the purged content (subject/body/attachment text) to search. It's
 * best-effort by design: a missing provider (search not configured) is a no-op, and a provider failure is logged and
 * swallowed rather than failing the purge itself - the primary-datastore delete is the authoritative one, and search
 * result handlers re-check each hit against the datastore before returning it.
 *
 * @param provider The injected `SearchProvider`, if any.
 * @param entityType The indexed entity type (`"message"` covers the message's attachment text too).
 * @param entityUids The purged entities' uids. Falsy entries are skipped.
 * @param logger Optional logger for failures.
 * @returns The number of uids whose removal failed.
 */
export async function removeFromSearchIndex(
    provider: SearchProvider | undefined,
    entityType: SearchEntityType,
    entityUids: (string | undefined | null)[] | string | undefined | null,
    logger?: { warn?: (...args: any[]) => void },
): Promise<number> {
    if (!provider) {
        return 0;
    }
    const uids: string[] = (Array.isArray(entityUids) ? entityUids : [entityUids]).filter((uid): uid is string => typeof uid === "string" && uid.length > 0);
    let failures = 0;
    for (const uid of uids) {
        try {
            await provider.remove(entityType, uid);
        } catch (err: any) {
            failures++;
            logger?.warn?.(`Failed to remove ${entityType}:${uid} from the search index: ${err?.message ?? err}`);
        }
    }
    return failures;
}
