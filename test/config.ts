///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2020-2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Used by Mongo-backed test suites (`test/routes/mongo/*`, `test/jobs/mongo/*`) - `acl` and the primary entity
// datastore are both MongoDB. SQL-backed test suites use `config.sql.ts` instead, which uses a real SQL-backed
// `acl` datastore (and no `mongo` datastore at all) so a "SQL test" has zero MongoDB dependency.
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
        acl: {
            type: "mongodb",
            url: "mongodb://localhost:9999/acls",
            synchronize: true,
        },
        mongo: {
            type: "mongodb",
            host: "localhost",
            port: 9999,
            database: "rrst-test",
            synchronize: true,
        },
        sql: sqlDatastoreConfig("rrst-test"),
    }),
);

export default conf;
