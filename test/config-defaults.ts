///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2020-2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Shared nconf defaults for the two test config variants (`config.ts` for Mongo-backed test suites,
// `config.sql.ts` for SQL-backed ones) - kept as a single factory so a config key added for one variant
// (e.g. a new job's schedule/batch_size) can't silently drift out of sync with the other.

/**
 * Builds the full nconf defaults object for a test run, parameterized only by which `datastores` are
 * configured - everything else is identical between the Mongo and SQL test variants.
 *
 * @param datastores The `datastores` block to use - the two variants differ only in whether `acl`/the primary
 * entity datastore are MongoDB- or SQL-backed, and whether a `mongo` datastore is present at all.
 */
export function buildTestConfigDefaults(datastores: Record<string, any>) {
    return {
        service_name: "mail_test_service",
        version: "1.0",
        // Set explicitly (rather than relying on Server's default of 3000) so the test suite never silently
        // collides with an unrelated process already listening on the default port in a developer's environment.
        port: 3737,
        cookie_secret: "f0fLSKFJLKWJFe09f32joff098u2fOFIWJ32890fnfnlak",
        cors: {
            origins: ["http://localhost:3000"],
        },
        datastores,
        // Specifies the group names that are considered to be trusted with administrative privileges.
        trusted_roles: ["admin"],
        // Settings pertaining to the signing and verification of authentication tokens
        auth: {
            strategy: "auth.JWTStrategy",
            allowQueryParam: true,
            secret: "MyPasswordIsSecure",
            options: {
                expiresIn: "7 days",
                audience: "mydomain.com",
                issuer: "api.mydomain.com",
            },
        },
        rbac: {
            enabled: true,
        },
        session: {
            secret: "SessionsHaveSecrets",
        },
        cluster_url: "http://localhost",
        metrics: {
            authRequired: false,
        },
        mail: {
            blob: {
                local: {
                    root: "./test/.tmp/blobs",
                },
            },
            transport: {
                ingest: {
                    secret: "test-ingest-secret",
                },
                sendmail: {
                    path: "/usr/sbin/sendmail",
                },
            },
            scan: {
                spam: {
                    rspamd: {
                        url: "http://127.0.0.1:19999",
                    },
                },
                av: {
                    clamav: {
                        host: "127.0.0.1",
                        port: 19998,
                    },
                },
                sanitize: {
                    allowed_tags: [],
                },
            },
            search: {
                extraction: {
                    max_bytes: 25000000,
                    timeout_ms: 30000,
                },
            },
            jobs: {
                scan_queue: { schedule: "*/10 * * * * *", batch_size: 25 },
                search_index: { schedule: "*/15 * * * * *", batch_size: 50 },
                attachment_extraction: { schedule: "*/20 * * * * *", batch_size: 25 },
                calendar_reminder: { schedule: "0 * * * * *", batch_size: 200, window_seconds: 60 },
                eas_device_cleanup: { schedule: "0 0 4 * * *", batch_size: 500, device_ttl_days: 90 },
                external_share_expiration: { schedule: "0 0 5 * * *", batch_size: 500 },
                quarantine_retention: { schedule: "0 0 6 * * *", batch_size: 500, retention_days: 30 },
                mailbox_quota_recalc: { schedule: "0 0 7 * * *", batch_size: 100 },
            },
        },
    };
}

/**
 * The `sql` datastore's TypeORM config shared by both variants (the SQL-backed ACL variant also uses this
 * shape, just under the `acl` key with a distinct `database` file).
 *
 * `invalidWhereValuesBehavior: { null: "sql-null" }`: several jobs (e.g. AttachmentExtractionJob,
 * SearchIndexJob, EasDeviceStateCleanupJob) query a nullable "not yet processed" marker column via a literal
 * `{ field: null }` value, which is the correct/only way to express that against MongoDB (a missing/null field
 * matches `{field: null}` there) but which TypeORM's `SelectQueryBuilder` rejects by default for SQL - it
 * throws ("Null value encountered ... the IsNull() operator must be used") rather than silently treating it as
 * `IS NULL`, and `ModelUtils`'s query-string DSL (see `@rapidrest/service-core`) has no operator that maps onto
 * TypeORM's dedicated `IsNull()`. `"sql-null"` is TypeORM's own supported escape hatch for exactly this shape
 * of query and is required for those jobs' SQL backends to function at all - this is a real config requirement
 * of this library's SQL datastore, not a test-only workaround (see the passed-straight-through `datasource`
 * object in `ConnectionManager`/`TypeOrmSupport.connect()`), and is documented here since a fresh SQL
 * deployment of this library would otherwise 500 on every run of those jobs.
 */
export function sqlDatastoreConfig(database: string) {
    return {
        type: "better-sqlite3",
        host: "localhost",
        database,
        synchronize: true,
        invalidWhereValuesBehavior: { null: "sql-null" },
    };
}
