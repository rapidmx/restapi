///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { NullEncryptionCertificateAuthority } from "../../src/pki/NullEncryptionCertificateAuthority.js";

describe("NullEncryptionCertificateAuthority Tests", () => {
    const authority = new NullEncryptionCertificateAuthority();

    it("Reports its own name.", () => {
        expect(authority.name).toBe("null");
    });

    it("issue() throws since no CA is configured.", async () => {
        await expect(authority.issue("alice@example.com", "csr")).rejects.toThrow(
            /No encryption certificate authority is configured/,
        );
    });

    it("revoke() throws since no CA is configured.", async () => {
        await expect(authority.revoke("deadbeef")).rejects.toThrow(/No encryption certificate authority is configured/);
    });
});
