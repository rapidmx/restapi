///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for importOptional() - exercised against a real, always-installed package (success) and
// a package name that definitely does not exist (failure), rather than mocking dynamic `import()` itself.
import { importOptional } from "../../src/util/OptionalDeps.js";

describe("importOptional() Tests", () => {
    it("Resolves the module namespace for an installed package.", async () => {
        const mod: any = await importOptional("nconf");
        expect(mod).toBeDefined();
        expect(mod.default ?? mod).toBeTruthy();
    });

    it("Throws an ApiError naming the package and install instructions when the package is not installed.", async () => {
        await expect(importOptional("this-package-does-not-exist-xyz")).rejects.toMatchObject({
            status: 500,
            message: expect.stringMatching(/this-package-does-not-exist-xyz/),
        });
    });

    it("The thrown error's message includes install instructions.", async () => {
        await expect(importOptional("this-package-does-not-exist-xyz")).rejects.toThrow(
            /yarn add this-package-does-not-exist-xyz/,
        );
    });
});
