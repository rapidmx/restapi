///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit test for how Rfc8823AcmeSigningCertificateEnrollment obtains its `health`: from the ObjectFactory, in its init hook.
import "reflect-metadata";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Logger } from "@rapidrest/core";
import { ObjectFactory } from "@rapidrest/service-core";
import { Rfc8823AcmeSigningCertificateEnrollment } from "../../src/pki/Rfc8823AcmeSigningCertificateEnrollment.js";
import { SigningEnrollmentHealth } from "../../src/pki/SigningEnrollmentHealth.js";
import config from "../config.js";
import { registerTestDoubles } from "../testDoubles.js";
import { TestEnrollment } from "./acmeTestDoubles.js";

describe("Rfc8823AcmeSigningCertificateEnrollment health Tests", () => {
    const storeKey = "mail:pki:rfc8823:store_dir";
    let previousStoreDir: any;
    let dir: string;
    let factory: ObjectFactory;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "rfc8823-health-"));
        previousStoreDir = config.get(storeKey);
        config.set(storeKey, dir);
        config.set("mail:pki:rfc8823:contact_email", "pki@example.com");
        factory = new ObjectFactory(config, Logger());
        registerTestDoubles(factory);
    });

    afterEach(async () => {
        await factory.destroy();
        config.set(storeKey, previousStoreDir);
        await fs.rm(dir, { recursive: true, force: true });
    });

    it("Obtains its health from the ObjectFactory, keeping its record in health.json in the store directory.", async () => {
        const enrollment = await factory.newInstance<TestEnrollment>(TestEnrollment, { name: "default" });

        expect(enrollment.health).toBeInstanceOf(SigningEnrollmentHealth);
        expect(enrollment.health).toBe(factory.getInstance(SigningEnrollmentHealth));

        await enrollment.health.record({ ok: false, error: "down" });

        expect(JSON.parse(await fs.readFile(path.join(dir, "health.json"), "utf-8"))).toEqual(expect.objectContaining({ consecutiveFailures: 1 }));
        expect(await enrollment.health.report()).toEqual(expect.objectContaining({ ok: false, lastError: "down" }));
    });

    it("Gives each store directory its own health.", async () => {
        const first = await factory.newInstance<TestEnrollment>(TestEnrollment, { name: "first" });
        config.set(storeKey, path.join(dir, "other"));
        const second = await factory.newInstance<TestEnrollment>(TestEnrollment, { name: "second" });

        expect(second.health).not.toBe(first.health);
    });

    it("Refuses to initialize without an ObjectFactory.", async () => {
        const bare: any = new Rfc8823AcmeSigningCertificateEnrollment();

        await expect(bare.initHealth()).rejects.toThrow("objectFactory is not set.");
    });
});
