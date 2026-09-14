///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for BaseEscrowAuditLogRoute's create()/update()/delete()/truncate() method
// bodies - see test/routes/BaseAuditLogRoute.test.ts's identical rationale, which this mirrors
// exactly. Every other reachable behavior of this class (holder-scoped find/count/findById, the
// trusted-only verify() chain check) is exercised via real HTTP+DB requests in
// test/routes/{sql,mongo}/EscrowAuditLogRoute.test.ts.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { BaseEscrowAuditLogRoute } from "../../src/routes/BaseEscrowAuditLogRoute.js";

class TestEscrowAuditLogRoute extends BaseEscrowAuditLogRoute<any> {
    protected escrowScopeClass: any = class {};
    protected matterClass: any = class {};
}

describe("BaseEscrowAuditLogRoute Tests (rejectWrite()-guarded method bodies only)", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());

    it("create() throws AUTH_PERMISSION_FAILURE.", async () => {
        const route = objectFactory.newInstance<TestEscrowAuditLogRoute>(TestEscrowAuditLogRoute, { initialize: false });

        await expect(route.create({} as any, {} as any)).rejects.toThrow(
            "EscrowAuditLogEntry records cannot be created, updated, or deleted through this API.",
        );
    });

    it("update() throws AUTH_PERMISSION_FAILURE.", async () => {
        const route = objectFactory.newInstance<TestEscrowAuditLogRoute>(TestEscrowAuditLogRoute, { initialize: false });

        await expect(route.update("id-1", {} as any, {} as any)).rejects.toThrow(
            "EscrowAuditLogEntry records cannot be created, updated, or deleted through this API.",
        );
    });

    it("delete() throws AUTH_PERMISSION_FAILURE.", async () => {
        const route = objectFactory.newInstance<TestEscrowAuditLogRoute>(TestEscrowAuditLogRoute, { initialize: false });

        await expect(route.delete("id-1", undefined, undefined, {} as any)).rejects.toThrow(
            "EscrowAuditLogEntry records cannot be created, updated, or deleted through this API.",
        );
    });

    it("truncate() throws AUTH_PERMISSION_FAILURE.", async () => {
        const route = objectFactory.newInstance<TestEscrowAuditLogRoute>(TestEscrowAuditLogRoute, { initialize: false });

        await expect(route.truncate({}, {})).rejects.toThrow(
            "EscrowAuditLogEntry records cannot be created, updated, or deleted through this API.",
        );
    });

    it("updateBulk() throws AUTH_PERMISSION_FAILURE.", async () => {
        const route = objectFactory.newInstance<TestEscrowAuditLogRoute>(TestEscrowAuditLogRoute, { initialize: false });

        await expect(route.updateBulk([], {} as any)).rejects.toThrow("EscrowAuditLogEntry records cannot be created, updated, or deleted through this API.");
    });

    it("updateProperty() throws AUTH_PERMISSION_FAILURE.", async () => {
        const route = objectFactory.newInstance<TestEscrowAuditLogRoute>(TestEscrowAuditLogRoute, { initialize: false });

        await expect(route.updateProperty("id-1", "targetUid", "x")).rejects.toThrow("EscrowAuditLogEntry records cannot be created, updated, or deleted through this API.");
    });
});
