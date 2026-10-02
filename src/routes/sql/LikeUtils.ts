///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { FindOperator, Raw } from "typeorm";

/**
 * The escape character of the `LIKE` patterns the SQL routes build, declared with `ESCAPE '!'`. Not a backslash: `ESCAPE '\'` is
 * an unterminated string literal on MySQL and MariaDB (where a backslash escapes the closing quote unless `NO_BACKSLASH_ESCAPES`
 * is set) but standard on SQLite and PostgreSQL, so no spelling of it works everywhere. `!` means the same on all of them.
 */
export const LIKE_ESCAPE: string = "!";

/** Escapes `value` for a `LIKE` pattern declared with `ESCAPE '!'`, so `%` and `_` (and the escape character itself) only ever match themselves. */
export function escapeLike(value: string): string {
    return value.replace(/[!%_]/g, (ch) => `${LIKE_ESCAPE}${ch}`);
}

/** A TypeORM `Raw()` predicate matching a column against the `LIKE` `pattern` (already escaped where it takes a value) with `ESCAPE '!'`.
 * TypeORM keeps the named parameters of one query in a single map, so predicates that share a query (the branches of an OR) each need
 * their own `name` - with the default one, the last pattern replaces every other. */
export function rawLike(pattern: string, name: string = "pattern"): FindOperator<string> {
    return Raw((alias) => `${alias} LIKE :${name} ESCAPE '${LIKE_ESCAPE}'`, { [name]: pattern });
}
