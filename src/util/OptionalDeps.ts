///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";

/**
 * Dynamically imports an optional peer dependency, throwing a helpful `ApiError` naming the package and its
 * install command if it is not installed. Mirrors `@rapidrest/auth`'s `importArgon2()`/`importOTPLib()`
 * convention so every optional adapter in this library (PDF/DOCX text extraction, OpenSearch) fails the same,
 * actionable way rather than with a raw `MODULE_NOT_FOUND` error.
 *
 * @param packageName The npm package name to import.
 */
export async function importOptional<T = any>(packageName: string): Promise<T> {
    try {
        return (await import(packageName)) as T;
    } catch (err: any) {
        throw new ApiError(
            ApiErrors.INTERNAL_ERROR,
            500,
            `This feature requires the optional peer dependency '${packageName}'. Install it with: yarn add ${packageName}`,
        );
    }
}
