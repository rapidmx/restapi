///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError } from "@rapidrest/core";
import { ApiErrors, ModelUtils } from "@rapidrest/service-core";
import { normalizeAddress } from "./AddressUtils.js";
import { boundIndexedValue } from "./ConversationUtils.js";
import { Message, MessageClassification, MessageImportance } from "../models/types.js";

/**
 * The denormalized, indexed scalar mirrors `Message` carries purely so a mail list can be sorted and filtered
 * by the database instead of by the client.
 *
 * `Message.flags` and `Message.from` are stored as a single `simple-json` column on the SQL backend (and as an
 * embedded sub-document on Mongo), and this framework's shared query DSL (`ModelUtils.buildSearchQuery`) has no
 * way to filter or sort on a field *inside* one of those on both backends - which is why "every flagged message
 * in this mailbox" previously had to be answered by fanning out one list call per folder and filtering in the
 * browser (`@rapidmx/react-shared`'s own `mail/flaggedMessages.ts` documents that workaround). These mirrors are
 * the fix: ordinary top-level columns, indexed alongside `folderUid`/`receivedDate`, that the server keeps in
 * lockstep with the nested fields they are derived from.
 *
 * They are `SERVER_MANAGED_MESSAGE_FIELDS` (see `BaseMessageRoute`) - never written from a request body, on any
 * path, by any caller including a trusted one. Every write derives them from the authoritative nested value
 * instead, so the two can't disagree because someone sent `{ read: true }` without `flags.read`.
 */
export interface MessageListFields {
    /** Mirrors `Message.flags.read`. */
    read: boolean;
    /** Mirrors `Message.flags.flagged`. */
    flagged: boolean;
    /** Mirrors `Message.from.address`, normalized (trimmed/lowercased) and length-bounded for indexing. */
    fromAddress: string;
    /** `Message.importance` as a sortable rank - see `MESSAGE_IMPORTANCE_RANKS`. */
    importanceRank: number;
}

/** The field names of `MessageListFields`, in one place so the model constructors, the route's
 * server-managed-field list and the sync helper below can't drift apart. */
export const MESSAGE_LIST_FIELDS: readonly (keyof MessageListFields)[] = ["read", "flagged", "fromAddress", "importanceRank"];

/** The `Message` fields `MessageListFields` is derived from - a write touching any of them re-derives the lot. */
export const MESSAGE_LIST_SOURCE_FIELDS: readonly string[] = ["flags", "from", "importance"];

/**
 * `MessageImportance` as a number that sorts the way a reader expects (high first, descending). The stored
 * enum values are strings, so sorting the `importance` column directly would order them alphabetically -
 * `high`, `low`, `normal` - which is neither the enum's own order nor a useful one.
 */
export const MESSAGE_IMPORTANCE_RANKS: Readonly<Record<string, number>> = {
    [MessageImportance.LOW]: 0,
    [MessageImportance.NORMAL]: 1,
    [MessageImportance.HIGH]: 2,
};

/** The rank stored for a message whose `importance` isn't one of the three known values (never written by this
 * library, but a row imported or written by another protocol package could carry anything). */
export const DEFAULT_IMPORTANCE_RANK: number = MESSAGE_IMPORTANCE_RANKS[MessageImportance.NORMAL];

/** `MESSAGE_IMPORTANCE_RANKS[importance]`, falling back to `DEFAULT_IMPORTANCE_RANK` for an unknown value.
 * `hasOwnProperty`, not `in`: `importance` reaches here from stored data, and `in` would answer `true` for
 * `toString`/`constructor` and hand back a function where a rank belongs. */
export function importanceRankOf(importance: unknown): number {
    return typeof importance === "string" && Object.prototype.hasOwnProperty.call(MESSAGE_IMPORTANCE_RANKS, importance)
        ? MESSAGE_IMPORTANCE_RANKS[importance]
        : DEFAULT_IMPORTANCE_RANK;
}

/**
 * Computes every `MessageListFields` value from the authoritative nested fields of `source`. Tolerates a
 * partially-populated object (a model constructor's `other`, an update patch merged over the stored row), so a
 * missing `flags`/`from` yields this library's own defaults rather than throwing.
 */
export function deriveMessageListFields(source: Partial<Message> | undefined): MessageListFields {
    const address: unknown = source?.from?.address;
    return {
        read: source?.flags?.read === true,
        flagged: source?.flags?.flagged === true,
        fromAddress: typeof address === "string" ? boundIndexedValue(normalizeAddress(address)) : "",
        importanceRank: importanceRankOf(source?.importance),
    };
}

/**
 * Keeps the mirrors correct on a *partial* write. `RepoUtils.update()` persists a patch object without ever
 * running the model constructor (see `BaseMessageRoute.prepareUpdate()`'s own note on `messageId`), so a patch
 * that flips `flags.read` would otherwise leave `read` stale and the Unread filter wrong.
 *
 * Re-derives from the patch merged over `existing`, so a patch carrying only `flags` still gets a `fromAddress`
 * consistent with the stored `from`. A patch touching none of `MESSAGE_LIST_SOURCE_FIELDS` is left untouched -
 * the stored mirrors are already right, and rewriting them would churn every update.
 *
 * Exported (and re-exported from the package root) so a protocol package that writes `Message.flags` itself -
 * `@rapidmx/activesync-plugin`'s message-flag sync, `@rapidmx/mapi-plugin`'s property writes - can apply the
 * same derivation instead of silently desynchronizing the list fields.
 *
 * @param patch The update object about to be persisted. Mutated in place.
 * @param existing The stored row the patch is being applied to, if known.
 */
export function syncMessageListFields(patch: Record<string, any>, existing?: Partial<Message>): void {
    if (!patch || !MESSAGE_LIST_SOURCE_FIELDS.some((field) => field in patch)) {
        return;
    }
    Object.assign(patch, deriveMessageListFields({ ...existing, ...patch }));
}

/**
 * The named list filters `BaseMessageRoute`'s `find()`/`count()`/`conversations()` accept as `?filter=`, mapped
 * to the query fragment each compiles to. Named rather than left to the generic `op(value)` DSL for two
 * reasons: `focused` needs a two-branch `$or` a client can't send (list routes strip `$`-prefixed query keys -
 * see `stripUnsafeQueryKeys()` in `BaseScopedChildRoute.ts`), and a fixed vocabulary keeps the client's filter
 * menu and the server's indexes describing the same small set of queries.
 *
 * Every value goes through `ModelUtils.literal()`, so nothing here is ever parsed as `op(value)` syntax.
 */
export const MESSAGE_LIST_FILTERS: Readonly<Record<string, () => Record<string, any>>> = {
    /** No predicate at all - the default. */
    all: () => ({}),
    unread: () => ({ read: ModelUtils.literal(false) }),
    read: () => ({ read: ModelUtils.literal(true) }),
    flagged: () => ({ flagged: ModelUtils.literal(true) }),
    /** Outlook's "Has files". */
    hasAttachments: () => ({ hasAttachments: ModelUtils.literal(true) }),
    /** Focused Inbox's focused half. `inferenceClassification` is only ever *set* for mail delivered to the
     * Inbox, and absent is defined to mean focused (see `Message.inferenceClassification`), so this has to
     * match a null/absent value too - hence the `$or` rather than a plain equality. */
    focused: () => ({
        $or: [{ inferenceClassification: ModelUtils.literal(MessageClassification.FOCUSED) }, { inferenceClassification: ModelUtils.literal(null) }],
    }),
    other: () => ({ inferenceClassification: ModelUtils.literal(MessageClassification.OTHER) }),
};

/** The names `?filter=` accepts, for a client building its filter menu. */
export const MESSAGE_LIST_FILTER_NAMES: readonly string[] = Object.keys(MESSAGE_LIST_FILTERS);

/**
 * The named sort keys `?sortBy=` accepts, mapped to the `Message` column each sorts on. Named rather than
 * letting a client name a column directly so that the two that need a denormalized mirror (`from`, backed by
 * `fromAddress` because `from` itself is a JSON sub-document, and `importance`, backed by `importanceRank`
 * because the enum's stored strings don't sort in a meaningful order) look no different to a caller than the
 * ones that don't.
 */
export const MESSAGE_LIST_SORTS: Readonly<Record<string, string>> = {
    /** Outlook's "Date" - the date the message arrived, and this list's default. */
    date: "receivedDate",
    sentDate: "sentDate",
    /** Outlook's "From". */
    from: "fromAddress",
    subject: "subject",
    /** Outlook's "Importance". */
    importance: "importanceRank",
    /** Outlook's "Flag status". */
    flagged: "flagged",
};

/** The names `?sortBy=` accepts, for a client building its sort menu. */
export const MESSAGE_LIST_SORT_NAMES: readonly string[] = Object.keys(MESSAGE_LIST_SORTS);

/** The sort keys that read most naturally newest/highest first, so `?sortOrder=` may be left off. */
const DESCENDING_BY_DEFAULT: ReadonlySet<string> = new Set(["date", "sentDate", "importance", "flagged"]);

/** The default `?sortBy=`, matching the list every mail client opens on. */
export const DEFAULT_MESSAGE_LIST_SORT: string = "date";

/**
 * Compiles `sortBy`/`sortOrder` into the `sort` object `ModelUtils.buildSearchQuery` understands.
 *
 * `receivedDate` and `uid` are always appended as tiebreakers (unless they *are* the primary key), so paging
 * with `limit`/`page` is stable: without a total order, two rows tied on the primary key can swap between one
 * page request and the next and a client sees the same message twice, or never at all.
 *
 * @throws {ApiError} 400 for an unknown `sortBy` or a `sortOrder` that isn't `asc`/`desc`.
 */
export function buildMessageListSort(sortBy: unknown, sortOrder: unknown): Record<string, "ASC" | "DESC"> {
    const key: string = sortBy === undefined || sortBy === "" ? DEFAULT_MESSAGE_LIST_SORT : String(sortBy);
    const field: string | undefined = Object.prototype.hasOwnProperty.call(MESSAGE_LIST_SORTS, key) ? MESSAGE_LIST_SORTS[key] : undefined;
    if (!field) {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'sortBy' must be one of: ${MESSAGE_LIST_SORT_NAMES.join(", ")}.`);
    }
    let descending: boolean = DESCENDING_BY_DEFAULT.has(key);
    if (sortOrder !== undefined && sortOrder !== "") {
        const order: string = String(sortOrder).toLowerCase();
        if (order !== "asc" && order !== "desc") {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'sortOrder' must be 'asc' or 'desc'.");
        }
        descending = order === "desc";
    }
    const sort: Record<string, "ASC" | "DESC"> = { [field]: descending ? "DESC" : "ASC" };
    if (field !== "receivedDate") {
        sort.receivedDate = "DESC";
    }
    sort.uid = "ASC";
    return sort;
}

/**
 * Compiles `?filter=` into its query fragment.
 *
 * @throws {ApiError} 400 for an unknown filter name.
 */
export function buildMessageListFilter(filter: unknown): Record<string, any> {
    if (filter === undefined || filter === "") {
        return {};
    }
    const name: string = String(filter);
    if (!Object.prototype.hasOwnProperty.call(MESSAGE_LIST_FILTERS, name)) {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'filter' must be one of: ${MESSAGE_LIST_FILTER_NAMES.join(", ")}.`);
    }
    return MESSAGE_LIST_FILTERS[name]();
}

/** Every query-string parameter `BaseMessageRoute` interprets itself rather than passing through as a field
 * filter - see `BaseScopedChildRoute.listQueryParams`. */
export const MESSAGE_LIST_QUERY_PARAMS: readonly string[] = ["filter", "sortBy", "sortOrder"];

/** Resolves a client `limit` to a bounded page size. Shared by the conversation endpoints, which page over
 * results this library computes itself rather than over a repository query (which `ModelUtils` would bound for
 * them). A missing/unparseable value yields `defaultLimit`. */
export function boundedListLimit(limit: unknown, defaultLimit: number, maxLimit: number): number {
    const parsed: number = typeof limit === "number" ? limit : parseInt(String(limit ?? ""), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return defaultLimit;
    }
    return Math.min(Math.floor(parsed), maxLimit);
}

/** Resolves a client `page` to a zero-based, non-negative page index. */
export function boundedListPage(page: unknown): number {
    const parsed: number = typeof page === "number" ? page : parseInt(String(page ?? ""), 10);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}
