///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";

/** The page size a request list (`GET /data-export-requests`, `/erasure-requests`, `/mailbox-import-requests`,
 * `/matter-export-requests`, `/escrow-access-requests`) returns when the caller sends no `?limit=`. */
export const DEFAULT_REQUEST_LIST_LIMIT = 100;

/** The largest `?limit=` a request list accepts. */
export const MAX_REQUEST_LIST_LIMIT = 500;

export interface ListPaging {
    limit: number;
    page: number;
}

function parseNonNegativeInteger(value: unknown, name: string): number | undefined {
    if (value === undefined || value === "") {
        return undefined;
    }
    const parsed: number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : typeof value === "number" ? value : NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'${name}' must be a non-negative integer.`);
    }
    return parsed;
}

/**
 * Parses a request list's `?limit=` (1 to `MAX_REQUEST_LIST_LIMIT`, default `DEFAULT_REQUEST_LIST_LIMIT`; larger
 * values are capped) and `?page=` (0-based, default 0). Anything else - a negative, fractional or non-numeric
 * value, or a repeated parameter - is a `400`.
 */
export function parseListPaging(query: { limit?: unknown; page?: unknown } | undefined): ListPaging {
    const limit: number | undefined = parseNonNegativeInteger(query?.limit, "limit");
    if (limit === 0) {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'limit' must be at least 1.");
    }
    return {
        limit: Math.min(limit ?? DEFAULT_REQUEST_LIST_LIMIT, MAX_REQUEST_LIST_LIMIT),
        page: parseNonNegativeInteger(query?.page, "page") ?? 0,
    };
}
