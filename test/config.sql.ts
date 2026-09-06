///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2020-2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Used by SQL-backed test suites (`test/routes/sql/*`, `test/jobs/sql/*`) - both the primary entity datastore
// AND the `acl` datastore are SQL (`better-sqlite3`), and no `mongo` datastore is configured at all, so a "SQL
// test" run has zero MongoDB dependency. `ACLUtils` (see `@rapidrest/service-core`) picks its concrete
// `AccessControlList{Mongo,SQL}` implementation automatically from the `acl` connection's actual runtime type,
// so this requires no source changes - only this config. `acl` uses its own database file, separate from the
// primary `sql` datastore's, so the two connections never contend over the same SQLite file.
import nconf from "nconf";
import { buildTestConfigDefaults, sqlDatastoreConfig } from "./config-defaults.js";

const conf = nconf.argv().env({
    separator: "__",
    lowerCase: true,
    parseValues: true,
});

conf.use("memory");

conf.defaults(
    buildTestConfigDefaults({
        acl: sqlDatastoreConfig("rrst-test-acl"),
        sql: sqlDatastoreConfig("rrst-test"),
    }),
);

export default conf;
