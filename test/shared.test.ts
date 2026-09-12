///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for shared.ts's optional-peer-dependency dynamic import() helpers. The success
// path is exercised against the real, already-installed `@aws-sdk/client-*` packages (all three are
// regular devDependencies of this repo, even though they're an optional *peer* dependency of a real
// deployment); the failure path is simulated with `vi.doMock()` making the target package's own module
// factory throw, which propagates as a rejection through the helper's own `import()` call - the same
// "make the import itself fail" technique, just applied per-test with `doMock`/`resetModules()` instead
// of a file-level `vi.mock()`, since each of the three packages needs both a success and a failure case
// in the same file.
import { importAwsClientS3, importAwsClientSES, importAwsClientSESv2 } from "../src/shared.js";

describe("shared.ts AWS SDK optional dependency imports", () => {
    afterEach(() => {
        vi.doUnmock("@aws-sdk/client-s3");
        vi.doUnmock("@aws-sdk/client-ses");
        vi.doUnmock("@aws-sdk/client-sesv2");
        vi.resetModules();
    });

    it("importAwsClientS3() resolves the real module when installed.", async () => {
        const mod: any = await importAwsClientS3();
        expect(mod.S3Client).toBeDefined();
    });

    it("importAwsClientSES() resolves the real module when installed.", async () => {
        const mod: any = await importAwsClientSES();
        expect(mod.SESClient).toBeDefined();
    });

    it("importAwsClientSESv2() resolves the real module when installed.", async () => {
        const mod: any = await importAwsClientSESv2();
        expect(mod.SESv2Client).toBeDefined();
    });

    it("importAwsClientS3() throws a helpful ApiError when the package fails to import.", async () => {
        vi.doMock("@aws-sdk/client-s3", () => {
            throw new Error("Cannot find module '@aws-sdk/client-s3'");
        });

        await expect(importAwsClientS3()).rejects.toMatchObject({ status: 500 });
        await expect(importAwsClientS3()).rejects.toThrow(/yarn add @aws-sdk\/client-s3/);
    });

    it("importAwsClientSES() throws a helpful ApiError when the package fails to import.", async () => {
        vi.doMock("@aws-sdk/client-ses", () => {
            throw new Error("Cannot find module '@aws-sdk/client-ses'");
        });

        await expect(importAwsClientSES()).rejects.toMatchObject({ status: 500 });
        await expect(importAwsClientSES()).rejects.toThrow(/yarn add @aws-sdk\/client-ses/);
    });

    it("importAwsClientSESv2() throws a helpful ApiError when the package fails to import.", async () => {
        vi.doMock("@aws-sdk/client-sesv2", () => {
            throw new Error("Cannot find module '@aws-sdk/client-sesv2'");
        });

        await expect(importAwsClientSESv2()).rejects.toMatchObject({ status: 500 });
        await expect(importAwsClientSESv2()).rejects.toThrow(/yarn add @aws-sdk\/client-sesv2/);
    });
});
