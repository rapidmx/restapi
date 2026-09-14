///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { BaseEntity, RepoUtils } from "@rapidrest/service-core";

/**
 * `row` as an instance of `repo`'s model class, for use as the `existing` argument of `RepoUtils.update()`.
 *
 * `update()` only enforces its optimistic lock (`existing.version !== obj.version` -> 409, and a version-filtered
 * write) when `existing instanceof BaseEntity`. The Mongo backend's `find()`/`findOne()` return plain documents,
 * so passing one straight through silently turns a version-checked claim into an unconditional overwrite - two
 * replicas could both "win" the same claim. SQL reads already return entity instances, which pass through as-is.
 */
export function asEntity<T>(repo: RepoUtils<any>, row: T): T {
    if (row instanceof BaseEntity) {
        return row;
    }
    const modelClass: any = (repo as any).modelClass;
    return modelClass ? new modelClass(row) : row;
}
