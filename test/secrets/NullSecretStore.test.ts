///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError } from "@rapidrest/core";
import { NO_SECRET_STORE_MESSAGE, NO_SECRET_STORE_READ_MESSAGE, NullSecretStore } from "../../src/secrets/NullSecretStore.js";
import { SecretStore } from "../../src/secrets/SecretStore.js";
import { SecretRef } from "../../src/models/types.js";

const REF: SecretRef = { backend: "openbao", path: "server/giphy", keys: ["apiKey"], generation: 1 };

/** The rejection of `call`, which must reject. */
async function rejectionOf(call: Promise<unknown>): Promise<any> {
    try {
        await call;
    } catch (err) {
        return err;
    }
    throw new Error("expected the call to reject");
}

describe("NullSecretStore", () => {
    const store: SecretStore = new NullSecretStore();

    it("says it has no backend", () => {
        expect(store.backend).toBe("none");
    });

    it("refuses to save credentials with a 400, so nothing is stored anywhere else", async () => {
        for (const call of [store.write("dns/cf1", { apiToken: "t0ken-value" }), store.patch(REF, { apiKey: "t0ken-value", other: null })]) {
            const err: any = await rejectionOf(call);
            expect(err).toBeInstanceOf(ApiError);
            expect(err.status).toBe(400);
            expect(err.message).toBe(NO_SECRET_STORE_MESSAGE);
            // A value given to the store is never repeated in what it throws.
            expect(err.message).not.toContain("t0ken-value");
        }
    });

    it("reports a read as unavailable (503), not as a mistake in the request that needed the secret", async () => {
        const err: any = await rejectionOf(store.read(REF));
        expect(err).toBeInstanceOf(ApiError);
        expect(err.status).toBe(503);
        expect(err.message).toBe(NO_SECRET_STORE_READ_MESSAGE);
        expect(err.message).not.toBe(NO_SECRET_STORE_MESSAGE);
    });

    it("lets a delete succeed, since it holds nothing, so a row with a reference can still be removed", async () => {
        await expect(store.delete(REF)).resolves.toBeUndefined();
        await expect(store.delete({ ...REF, backend: "kubernetes" })).resolves.toBeUndefined();
    });

    it("rejects rather than throwing synchronously, so callers can await it like a real store", () => {
        expect(() => void store.write("dns/cf1", {}).catch(() => undefined)).not.toThrow();
        expect(() => void store.read(REF).catch(() => undefined)).not.toThrow();
    });
});
