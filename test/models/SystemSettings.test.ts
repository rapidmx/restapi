///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MailboxPolicyMongo } from "../../src/models/mongo/MailboxPolicyMongo.js";
import { SetupStateMongo } from "../../src/models/mongo/SetupStateMongo.js";
import { MailboxPolicySQL } from "../../src/models/sql/MailboxPolicySQL.js";
import { SetupStateSQL } from "../../src/models/sql/SetupStateSQL.js";

describe.each([
    ["MailboxPolicyMongo", MailboxPolicyMongo, { defaultQuotaBytes: 1, autoProvisionEnabled: true, autoProvisionQuotaBytes: 2 }],
    ["MailboxPolicySQL", MailboxPolicySQL, { defaultQuotaBytes: 1, autoProvisionEnabled: true, autoProvisionQuotaBytes: 2 }],
    ["SetupStateMongo", SetupStateMongo, { startedAt: new Date(1), completedAt: new Date(2), currentStep: "domain" }],
    ["SetupStateSQL", SetupStateSQL, { startedAt: new Date(1), completedAt: new Date(2), currentStep: "domain" }],
])("%s", (_name, Model: any, values: Record<string, unknown>) => {
    it("leaves every field unset by default and applies provided values", () => {
        for (const obj of [new Model(), new Model({})]) {
            for (const key of Object.keys(values)) {
                expect(obj[key]).toBeUndefined();
            }
        }
        expect(new Model(values)).toEqual(expect.objectContaining(values));
    });
});
