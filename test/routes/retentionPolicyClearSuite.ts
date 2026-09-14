///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Clearing retention periods through PUT /retention-policy - identical on both backends. The route test files each
// supply a started server, an admin token, and a reader for the stored policy row.
import { request } from "@rapidrest/service-core/test";
import { MIN_AUDIT_LOG_RETENTION_DAYS } from "../../src/models/types.js";

export interface RetentionPolicyClearSuiteContext {
    app: () => any;
    baseUrl: string;
    adminToken: () => string;
    /** The stored singleton row, if any. */
    storedPolicy: () => Promise<any>;
}

export function retentionPolicyClearSuite(ctx: RetentionPolicyClearSuiteContext): void {
    const put = (body: unknown) => request(ctx.app()).put(ctx.baseUrl).set("Authorization", "jwt " + ctx.adminToken()).send(body);

    describe("clearing a retention period", () => {
        it("clears a field sent as null back to no automatic purge, leaving the other field alone", async () => {
            expect((await put({ messageRetentionDays: 365, auditLogRetentionDays: MIN_AUDIT_LOG_RETENTION_DAYS })).status).toBe(200);

            const cleared = await put({ messageRetentionDays: null });
            expect(cleared.status).toBe(200);
            expect(cleared.body).toEqual({ auditLogRetentionDays: MIN_AUDIT_LOG_RETENTION_DAYS });
            expect((await ctx.storedPolicy()).messageRetentionDays ?? undefined).toBeUndefined();

            const both = await put({ messageRetentionDays: null, auditLogRetentionDays: null });
            expect(both.status).toBe(200);
            expect(both.body).toEqual({});
            const stored = await ctx.storedPolicy();
            expect([stored.messageRetentionDays ?? undefined, stored.auditLogRetentionDays ?? undefined]).toEqual([undefined, undefined]);
            expect((await request(ctx.app()).get(ctx.baseUrl).set("Authorization", "jwt " + ctx.adminToken())).body).toEqual({});
        });

        it("still rejects an invalid non-null value", async () => {
            for (const body of [{ messageRetentionDays: 0 }, { messageRetentionDays: "30" }, { auditLogRetentionDays: MIN_AUDIT_LOG_RETENTION_DAYS - 1 }]) {
                const result = await put(body);
                expect(result.status).toBe(400);
            }
            expect(await ctx.storedPolicy()).toBeFalsy();
        });
    });
}
