///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { NullSigningCertificateEnrollment } from "../../src/pki/NullSigningCertificateEnrollment.js";

describe("NullSigningCertificateEnrollment Tests", () => {
    const enrollment = new NullSigningCertificateEnrollment();

    it("Reports its own name.", () => {
        expect(enrollment.name).toBe("null");
    });

    it("startEnrollment() throws since signing certificates are unavailable/disabled.", async () => {
        await expect(enrollment.startEnrollment("alice@example.com", "csr")).rejects.toThrow(
            /Signing certificate enrollment is not available/,
        );
    });

    it("checkStatus() throws since signing certificates are unavailable/disabled.", async () => {
        await expect(enrollment.checkStatus("some-id")).rejects.toThrow(/Signing certificate enrollment is not available/);
    });
});
