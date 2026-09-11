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
        // Read by `RateLimiter` (see `@rapidrest/service-core`), which backs the `@RateLimit()` decorator on
        // `BaseBookingRoute`'s three mutating endpoints. The framework's own defaults (5 attempts / 5 minutes)
        // are tuned for credential endpoints and are far too tight for appointment booking - a single visitor
        // correcting a typo would trip them. Raised here for the same reason a real deployment exposing those
        // routes has to raise them, and deliberately not disabled outright so the decorator stays exercised.
        rateLimit: {
            enabled: true,
            maxAttempts: 1000,
            windowSeconds: 300,
            ip: {
                enabled: true,
                maxAttempts: 5000,
                windowSeconds: 300,
            },
        },
        mail: {
            blob: {
                local: {
                    root: "./test/.tmp/blobs",
                },
            },
            dns: {
                mx_hostname: "mail.rapidmx-test.example.com",
            },
            // Matches the `authserv-id` (`mx.example.com`) used by every test fixture's `Authentication-Results`
            // header - see `ScanQueueJob`'s `trustedAuthservId`/`util/AuthenticationResultsUtils.ts`'s
            // `hasAlignedPassingDkim()`, which now fail closed on any other (or absent) `authserv-id`.
            security: {
                trusted_authserv_id: "mx.example.com",
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
                scheduled_send: { schedule: "*/30 * * * * *", batch_size: 50 },
                oof_suppression_cleanup: { schedule: "0 30 6 * * *", batch_size: 500, retention_days: 30 },
                meeting_scheduling: { schedule: "0 */5 * * * *", batch_size: 100 },
                domain_verification: { schedule: "0 */5 * * * *", batch_size: 100 },
            },
            oof: {
                resuppress_after_hours: 24,
            },
            focused_inbox: {
                enabled: true,
                other_spam_score: 3,
            },
            booking: {
                public_url: "https://bookings.rapidmx-test.example.com",
            },
            branding: {
                public_url: "https://branding-assets.rapidmx-test.example.com",
            },
            plus_addressing: {
                enabled: true,
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
 * `IS NULL`. `ModelUtils`'s query-string DSL (`@rapidrest/service-core` 2.0+) now *does* have operators that
 * map onto TypeORM's dedicated `IsNull()` - `eq(null)`/a bare `"null"` value, and `exists(false)` - so those
 * call sites could migrate off this literal-`null` shape; if they do, use `eq(null)`, not `exists(false)`,
 * since `exists(false)` maps to MongoDB `$exists: false` (missing only) rather than `$eq: null`
 * (missing-or-null), and these "not yet processed" marker columns rely on matching both. Regardless of
 * whether those call sites migrate, `"sql-null"` remains required: it is TypeORM's own supported escape hatch
 * for a literal `{ field: null }` value specifically, and is a real config requirement of this library's SQL
 * datastore, not a test-only workaround (see the passed-straight-through `datasource` object in
 * `ConnectionManager`/`TypeOrmSupport.connect()`) - **a fresh SQL deployment of this library MUST set this, or
 * it 500s on every run of those jobs.** (Also documented in the deployment README/config reference.)
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
