///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The installation id's shape and the refusal of a row that holds something else. Creating the row once on a real database, concurrently included, is in
// test/routes/dnsProviderSuite.ts.
import { DEPLOYMENT_IDENTITY_UID, findOrCreateDeploymentIdentity, INSTALLATION_ID_PATTERN, newInstallationId } from "../../src/util/DeploymentIdentityUtils.js";

describe("DeploymentIdentityUtils", () => {
    it("makes 16 random lowercase letters and digits", () => {
        const ids = new Set(Array.from({ length: 100 }, () => newInstallationId()));
        expect(ids.size).toBe(100);
        for (const id of ids) {
            expect(id).toMatch(INSTALLATION_ID_PATTERN);
        }
    });

    it.each([[undefined], [42], ["ABCDEFGHIJKLMNOP"], ["short"]])("refuses a stored installation id of %j rather than replacing it", async (installationId) => {
        const repo: any = { findOne: vi.fn(async () => ({ uid: DEPLOYMENT_IDENTITY_UID, installationId })), create: vi.fn() };
        await expect(findOrCreateDeploymentIdentity(repo)).rejects.toThrow(/malformed/);
        expect(repo.create).not.toHaveBeenCalled();
    });
});
