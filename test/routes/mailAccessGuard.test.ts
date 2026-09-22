///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The architecture guard behind "no role reads another user's mail": it fails when a route is added (or changed) without
// being accounted for, so the next route has to be put through the audit table and, when it serves a mailbox's data,
// through the access matrix.
import * as fs from "fs";
import * as path from "path";
import * as mongoRoutes from "../../src/routes/mongo/index.js";
import * as sqlRoutes from "../../src/routes/sql/index.js";
import { MailPushRoute } from "../../src/push/MailPushRoute.js";
import { matrixRouteClasses } from "./mailAccessMatrixSuite.js";
import { ROUTE_TABLE, TRUSTED_ROLE_USES } from "./mailAccessRouteTable.js";

const ROUTES_DIR = path.resolve(__dirname, "../../src/routes");

/** Every `*.ts` source file under `dir`, recursively. */
function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? sourceFiles(full) : entry.name.endsWith(".ts") ? [full] : [];
    });
}

/** The concrete route class names registered by the package, without their backend suffix. */
function concreteRouteNames(): string[] {
    const names = new Set<string>([MailPushRoute.name]);
    for (const exported of Object.keys(mongoRoutes)) {
        names.add(exported.replace(/Mongo$/, ""));
    }
    for (const exported of Object.keys(sqlRoutes)) {
        names.add(exported.replace(/SQL$/, ""));
    }
    return [...names].filter((name) => name.endsWith("Route")).sort();
}

describe("Mail access guard", () => {
    it("Classifies every concrete route class in the audit table.", () => {
        const missing = concreteRouteNames().filter((name) => !(name in ROUTE_TABLE));
        expect(missing, `route classes not in test/routes/mailAccessRouteTable.ts - classify them (mailbox / user / compliance / admin / public): ${missing}`).toEqual([]);
    });

    it("Has no stale row in the audit table (a route that was removed or renamed).", () => {
        const known = new Set(concreteRouteNames());
        const stale = Object.keys(ROUTE_TABLE).filter((name) => !known.has(name));
        expect(stale).toEqual([]);
    });

    it("Puts every mailbox-scoped route class through the access matrix.", () => {
        const covered = matrixRouteClasses();
        const uncovered = Object.entries(ROUTE_TABLE)
            // Push has its own protocol-level test (test/push/MailPushAccess.test.ts), which is also the only place it can run.
            .filter(([name, row]) => row.kind === "mailbox" && name !== "MailPushRoute" && !covered.has(name))
            .map(([name]) => name);
        expect(uncovered, `mailbox-scoped routes with no case in test/routes/mailAccessMatrixSuite.ts: ${uncovered}`).toEqual([]);
    });

    it("Names, for every table row, the Base route class that really exists in src/routes.", () => {
        const bases = new Set(
            sourceFiles(ROUTES_DIR)
                .map((file) => path.basename(file, ".ts"))
                .filter((name) => name.startsWith("Base")),
        );
        bases.add("MailPushRoute");
        const wrong = Object.entries(ROUTE_TABLE)
            .filter(([, row]) => !bases.has(row.base) && row.base !== "MailPushRoute")
            .map(([name, row]) => `${name} -> ${row.base}`);
        expect(wrong).toEqual([]);
        // ... and every Base route class is the base of some row: a new Base*Route file with no row is an unclassified route.
        const used = new Set(Object.values(ROUTE_TABLE).map((row) => row.base));
        const unclassified = [...bases].filter((name) => name.endsWith("Route") && !used.has(name) && name !== "MailPushRoute");
        expect(unclassified, `Base route classes no table row names: ${unclassified}`).toEqual([]);
    });

    it("Never calls ACLUtils.hasPermission() directly from a route: it treats a trusted role as a superuser, so mailbox-scoped code goes through hasMailAccess().", () => {
        const offenders = sourceFiles(ROUTES_DIR)
            .filter((file) => /aclUtils[!?]?\.hasPermission\(/.test(fs.readFileSync(file, "utf8")))
            .map((file) => path.relative(ROUTES_DIR, file));
        expect(offenders).toEqual([]);
    });

    it("Lists every route file that mentions a trusted role, with the reason it doesn't widen access to a mailbox.", () => {
        const using = sourceFiles(ROUTES_DIR)
            .filter((file) => /\bhasRoles\(|\bisTrusted\(/.test(fs.readFileSync(file, "utf8")))
            .map((file) => path.basename(file))
            .sort();
        const unlisted = using.filter((name) => !(name in TRUSTED_ROLE_USES));
        expect(unlisted, `route files using a trusted role that test/routes/mailAccessRouteTable.ts (TRUSTED_ROLE_USES) doesn't explain: ${unlisted}`).toEqual([]);
        const stale = Object.keys(TRUSTED_ROLE_USES).filter((name) => !using.includes(name));
        expect(stale).toEqual([]);
    });
});
