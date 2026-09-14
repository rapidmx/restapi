///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { PersistenceDecorators } from "@rapidrest/service-core";
import * as sqlModels from "./index.js";

/** The TypeORM driver types `applySqlDriverColumnTypes()` adjusts columns for. */
export const MYSQL_FAMILY_DRIVER_TYPES: readonly string[] = ["mysql", "mariadb"];

/** The subset of TypeORM's `MetadataArgsStorage` that `applySqlDriverColumnTypes()` reads and writes. */
export interface ColumnArgsStorage {
    columns: any[];
}

/** `true` for a TypeORM `FindOperator` (`Raw()`, `Like()`, `In()`, ...), matched without importing TypeORM. */
function isFindOperator(value: any): boolean {
    return (
        value !== null &&
        typeof value === "object" &&
        (value["@instanceof"] === Symbol.for("FindOperator") || value.constructor?.name === "FindOperator")
    );
}

/**
 * Serializes a `simple-json` property stored in a MySQL `LONGTEXT` column exactly the way TypeORM's own
 * `simple-json` handling does (`JSON.stringify` on write, `JSON.parse` of a string on read), so the stored text is
 * byte-identical and existing `LIKE`/`Raw()` matches against the serialized form keep working. A `FindOperator`
 * passes through untouched - TypeORM hands `where` operators to the transformer too, and serializing a `Raw()` or
 * `Like()` would break the query.
 */
export const SIMPLE_JSON_LONGTEXT_TRANSFORMER = {
    to(value: any): any {
        return value === null || value === undefined || isFindOperator(value) ? value : JSON.stringify(value);
    },
    from(value: any): any {
        return typeof value === "string" ? JSON.parse(value) : value;
    },
};

/** Every SQL model class `@rapidmx/restapi` exports (anything carrying a framework `@DataStore`). */
function restapiSqlEntities(): any[] {
    return Object.values(sqlModels).filter(
        (value: any) => typeof value === "function" && Reflect.getMetadata("rrst:datasource", value) !== undefined,
    );
}

/** The MySQL-family column options to use in place of a column's framework-declared type, if it needs any. */
function mysqlColumnOverride(type: any): Record<string, any> | undefined {
    if (type === "text") {
        return { type: "longtext" };
    }
    if (type === "simple-json") {
        return { type: "longtext", transformer: SIMPLE_JSON_LONGTEXT_TRANSFORMER };
    }
    if (type === Date || type === "datetime" || type === "timestamp") {
        return { type, precision: 3 };
    }
    return undefined;
}

/**
 * Adjusts the TypeORM column types of SQL entities for MySQL/MariaDB, where the framework's `@Column` (which can
 * only declare a column's `type`, not a length or precision) maps to types too small for this library's data:
 *
 * - `text` -> `LONGTEXT`. MySQL `TEXT` holds 64 KB; a longer subject, body preview, error message etc. is rejected
 * in strict mode (losing the write) or silently truncated.
 * - `simple-json` -> `LONGTEXT` with `SIMPLE_JSON_LONGTEXT_TRANSFORMER`. TypeORM stores `simple-json` as `TEXT` on
 * MySQL, so a large recipient list, `references` chain, attendee list etc. fails the same way. Stored text is
 * unchanged.
 * - Date columns -> `DATETIME(3)`. MySQL's default `DATETIME` drops milliseconds, which breaks anything that
 * round-trips a JS `Date` exactly - notably `EscrowAuditLogEntry.occurredAt`, whose millisecond value is part of
 * the escrow audit hash chain, so every entry would fail verification after a read-back.
 *
 * Postgres and SQLite need none of this (`text` is unbounded, `simple-json` is `text`, `timestamp` keeps
 * microseconds), so any other `driverType` is a no-op.
 *
 * Call it once, before the server connects its SQL datastore (e.g. before `Server.start()`), with that
 * datastore's configured `type`. It works by registering (or updating) each column's entry in TypeORM's global
 * metadata args storage; the framework's own `registerFrameworkMetadata()` never overwrites an existing entry,
 * and TypeORM uses the first entry registered for a property, so the adjustment survives. Idempotent.
 *
 * Existing MySQL/MariaDB databases: `synchronize: true` applies a `TEXT` -> `LONGTEXT` change by dropping and
 * re-adding the column (losing its data), so convert those columns in place with `ALTER TABLE ... MODIFY` first. The
 * `DATETIME` -> `DATETIME(3)` precision change is applied in place.
 *
 * @param driverType The SQL datastore's TypeORM `type` (e.g. `config.get("datastores:sql:type")`).
 * @param entities The entity classes to adjust. Defaults to every SQL model this library exports; pass any other
 * entities sharing the datastore (e.g. plugin models) explicitly, including this library's if you pass a list.
 * @param storage TypeORM's metadata args storage. Defaults to `typeorm.getMetadataArgsStorage()` (loaded only for a
 * MySQL-family driver, so a deployment without TypeORM can still import this module).
 * @returns The number of columns registered or updated.
 */
export async function applySqlDriverColumnTypes(
    driverType: string | undefined,
    entities: any[] = restapiSqlEntities(),
    storage?: ColumnArgsStorage,
): Promise<number> {
    if (!driverType || !MYSQL_FAMILY_DRIVER_TYPES.includes(driverType)) {
        return 0;
    }
    if (!storage) {
        const typeorm: any = await import("typeorm");
        storage = typeorm.getMetadataArgsStorage() as ColumnArgsStorage;
    }

    let adjusted: number = 0;
    for (const entity of entities) {
        for (const column of PersistenceDecorators.getColumnMetadata(entity)) {
            if (column.options.isObjectId) {
                continue;
            }
            const override: Record<string, any> | undefined = mysqlColumnOverride(column.options.type ?? column.designType);
            if (!override) {
                continue;
            }
            const existing: any = storage.columns.find(
                (c: any) => c.target === entity && c.propertyName === column.propertyName,
            );
            if (existing) {
                existing.options = { ...existing.options, ...override };
            } else {
                // Registered against the entity class itself (a column may be declared on a base class shared with
                // other entities, whose own registration must stay untouched) and at the front of the array:
                // TypeORM resolves a property registered on several classes of one inheritance chain to whichever
                // registration comes first.
                storage.columns.unshift({
                    target: entity,
                    propertyName: column.propertyName,
                    mode: "regular",
                    options: {
                        ...(column.options.name !== undefined ? { name: column.options.name } : {}),
                        ...(column.options.nullable !== undefined ? { nullable: column.options.nullable } : {}),
                        ...(column.options.primary ? { primary: true } : {}),
                        ...override,
                    },
                });
            }
            adjusted++;
        }
    }
    return adjusted;
}
