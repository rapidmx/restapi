///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for BaseAuditLogRoute's create()/update()/delete()/truncate() method bodies.
// Each is decorated `@Before("rejectWrite")`, which throws before the router ever calls the method
// body itself - test/routes/{sql,mongo}/AuditLogRoute.test.ts already confirms every one of these
// returns 403 over real HTTP, but that request never reaches the `return this.rejectWrite();`
// statement inside the method it's calling. These tests call the methods directly, bypassing the
// `@Before` middleware, to exercise that otherwise-unreachable line.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { BaseAuditLogRoute } from "../../src/routes/BaseAuditLogRoute.js";

class TestAuditLogRoute extends BaseAuditLogRoute<any> {}

describe("BaseAuditLogRoute Tests (rejectWrite()-guarded method bodies only)", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());

    it("create() throws AUTH_PERMISSION_FAILURE.", async () => {
        const route = objectFactory.newInstance<TestAuditLogRoute>(TestAuditLogRoute, { initialize: false });

        await expect(route.create({} as any, {} as any)).rejects.toThrow(
            "AuditLogEntry records cannot be created, updated, or deleted through this API.",
        );
    });

    it("update() throws AUTH_PERMISSION_FAILURE.", async () => {
        const route = objectFactory.newInstance<TestAuditLogRoute>(TestAuditLogRoute, { initialize: false });

        await expect(route.update("id-1", {} as any, {} as any)).rejects.toThrow(
            "AuditLogEntry records cannot be created, updated, or deleted through this API.",
        );
    });

    it("delete() throws AUTH_PERMISSION_FAILURE.", async () => {
        const route = objectFactory.newInstance<TestAuditLogRoute>(TestAuditLogRoute, { initialize: false });

        await expect(route.delete("id-1", undefined, undefined, {} as any)).rejects.toThrow(
            "AuditLogEntry records cannot be created, updated, or deleted through this API.",
        );
    });

    it("truncate() throws AUTH_PERMISSION_FAILURE.", async () => {
        const route = objectFactory.newInstance<TestAuditLogRoute>(TestAuditLogRoute, { initialize: false });

        await expect(route.truncate({}, {})).rejects.toThrow(
            "AuditLogEntry records cannot be created, updated, or deleted through this API.",
        );
    });

    it("updateBulk() throws AUTH_PERMISSION_FAILURE.", async () => {
        const route = objectFactory.newInstance<TestAuditLogRoute>(TestAuditLogRoute, { initialize: false });

        await expect(route.updateBulk([], {} as any)).rejects.toThrow("AuditLogEntry records cannot be created, updated, or deleted through this API.");
    });

    it("updateProperty() throws AUTH_PERMISSION_FAILURE.", async () => {
        const route = objectFactory.newInstance<TestAuditLogRoute>(TestAuditLogRoute, { initialize: false });

        await expect(route.updateProperty("id-1", "targetUid", "x")).rejects.toThrow("AuditLogEntry records cannot be created, updated, or deleted through this API.");
    });
});
