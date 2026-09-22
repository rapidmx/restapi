///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The signing-certificate enrollment stage machine, one transition at a time - pure functions, no I/O.
import {
    AcmeMilestones,
    classifyOrderFailure,
    classifyTransientFailure,
    computeManualStages,
    computeStages,
} from "../../src/pki/EnrollmentStages.js";

const T0 = "2026-09-21T10:00:00.000Z";
const T1 = "2026-09-21T10:01:00.000Z";
const T2 = "2026-09-21T10:06:00.000Z";
const T3 = "2026-09-21T10:11:00.000Z";
const T4 = "2026-09-21T10:16:00.000Z";
const T5 = "2026-09-21T10:21:00.000Z";

const submitted: AcmeMilestones = { status: "pending", createdAt: T0, hasDigest: false };

const states = (milestones: AcmeMilestones): string[] => computeStages(milestones).stages.map((stage) => `${stage.id}:${stage.state}`);

describe("computeStages()", () => {
    it("lists the RFC 8823 sequence with truthful labels", () => {
        expect(computeStages(submitted).stages.map((stage) => stage.label)).toEqual([
            "Request submitted",
            "Verification e-mail sent by the CA",
            "Verification e-mail answered",
            "CA validating",
            "Certificate being issued",
            "Certificate issued",
        ]);
    });

    it("is awaiting the CA's verification e-mail right after the request is submitted", () => {
        const report = computeStages(submitted);

        expect(report.stage).toBe("awaiting-challenge");
        expect(states(submitted)).toEqual([
            "submitted:done",
            "awaiting-challenge:active",
            "challenge-answered:pending",
            "validating:pending",
            "issuing:pending",
            "issued:pending",
        ]);
        expect(report.stages[0].at).toBe(T0);
        expect(report.stages[1].at).toBeUndefined();
        expect(report.progress).toBe(15);
    });

    it("moves to answering the challenge once the verification e-mail arrived", () => {
        const milestones: AcmeMilestones = { ...submitted, challengeReceivedAt: T1, hasDigest: true };

        const report = computeStages(milestones);

        expect(report.stage).toBe("challenge-answered");
        expect(states(milestones).slice(0, 3)).toEqual(["submitted:done", "awaiting-challenge:done", "challenge-answered:active"]);
        expect(report.stages[1].at).toBe(T1);
        expect(report.progress).toBe(40);
    });

    it("treats a recorded digest with no timestamp (a record from before the timestamps) as the e-mail having arrived", () => {
        expect(computeStages({ ...submitted, hasDigest: true }).stage).toBe("challenge-answered");
    });

    it("is validating once the reply was sent", () => {
        const milestones: AcmeMilestones = { ...submitted, challengeReceivedAt: T1, hasDigest: true, replySentAt: T2 };

        const report = computeStages(milestones);

        expect(report.stage).toBe("validating");
        expect(states(milestones)).toEqual([
            "submitted:done",
            "awaiting-challenge:done",
            "challenge-answered:done",
            "validating:active",
            "issuing:pending",
            "issued:pending",
        ]);
        expect(report.stages[2].at).toBe(T2);
        expect(report.progress).toBe(60);
    });

    it("is issuing once the order was finalized, and once the CA reports it processing even with no finalize timestamp", () => {
        const finalized: AcmeMilestones = { ...submitted, hasDigest: true, replySentAt: T2, finalizedAt: T3, orderStatus: "ready" };
        expect(computeStages(finalized).stage).toBe("issuing");
        expect(computeStages(finalized).stages[3]).toEqual(expect.objectContaining({ state: "done", at: T3 }));
        expect(computeStages(finalized).progress).toBe(85);

        expect(computeStages({ ...submitted, hasDigest: true, replySentAt: T2, orderStatus: "processing" }).stage).toBe("issuing");
        expect(computeStages({ ...submitted, hasDigest: true, replySentAt: T2, orderStatus: "pending" }).stage).toBe("validating");
    });

    it("is issued, every stage done, once the certificate is stored", () => {
        const milestones: AcmeMilestones = { status: "issued", createdAt: T0, hasDigest: true, challengeReceivedAt: T1, replySentAt: T2, finalizedAt: T3, issuedAt: T4 };

        const report = computeStages(milestones);

        expect(report.stage).toBe("issued");
        expect(report.progress).toBe(100);
        expect(states(milestones).every((state) => state.endsWith(":done"))).toBe(true);
        expect(report.stages[4].at).toBe(T4);
        expect(report.stages[5].at).toBe(T4);
    });

    it("reads an issued record that has no timestamps at all as fully done", () => {
        const report = computeStages({ status: "issued", createdAt: T0, hasDigest: false });

        expect(report.stage).toBe("issued");
        expect(report.stages.every((stage) => stage.state === "done")).toBe(true);
        expect(report.stages[5].at).toBeUndefined();
    });

    it("fails in the stage the enrollment had reached, keeping that stage's progress", () => {
        const awaiting = computeStages({ ...submitted, status: "failed", failedAt: T1 });
        expect(awaiting.stage).toBe("failed");
        expect(awaiting.stages.map((stage) => stage.state)).toEqual(["done", "failed", "pending", "pending", "pending", "pending"]);
        expect(awaiting.stages[1].at).toBe(T1);
        expect(awaiting.progress).toBe(15);

        const validating = computeStages({ ...submitted, status: "failed", hasDigest: true, replySentAt: T2, failedAt: T3 });
        expect(validating.stages.map((stage) => stage.state)).toEqual(["done", "done", "done", "failed", "pending", "pending"]);
        expect(validating.progress).toBe(60);

        const issuing = computeStages({ ...submitted, status: "failed", hasDigest: true, replySentAt: T2, finalizedAt: T3, failedAt: T4 });
        expect(issuing.stages.map((stage) => stage.state)).toEqual(["done", "done", "done", "done", "failed", "pending"]);
    });

    it("fails on the last stage - and never reads as complete - when an issued certificate was cancelled before it was installed", () => {
        const report = computeStages({
            status: "failed",
            createdAt: T0,
            hasDigest: true,
            replySentAt: T2,
            finalizedAt: T3,
            issuedAt: T4,
            failedAt: T5,
        });

        expect(report.stage).toBe("failed");
        expect(report.stages.map((stage) => stage.state)).toEqual(["done", "done", "done", "done", "done", "failed"]);
        expect(report.stages[5].at).toBe(T5);
        expect(report.progress).toBe(90);
    });

    it("omits `at` for a failed stage with no failure time", () => {
        const report = computeStages({ ...submitted, status: "failed" });

        expect(report.stages[1]).toEqual({ id: "awaiting-challenge", label: "Verification e-mail sent by the CA", state: "failed" });
    });
});

describe("computeManualStages()", () => {
    it("reports a single active stage while an administrator has yet to upload the certificate", () => {
        expect(computeManualStages({ status: "pending", createdAt: T0 })).toEqual({
            stage: "submitted",
            stages: [{ id: "submitted", label: "Waiting for an administrator to upload the certificate", state: "active", at: T0 }],
            progress: 5,
        });
    });

    it("reports issued, with when, once the certificate was uploaded (or without when for an older record)", () => {
        const withTime = computeManualStages({ status: "issued", createdAt: T0, issuedAt: T4 });
        expect(withTime.stage).toBe("issued");
        expect(withTime.progress).toBe(100);
        expect(withTime.stages.map((stage) => `${stage.id}:${stage.state}`)).toEqual(["submitted:done", "issued:done"]);
        expect(withTime.stages[1].at).toBe(T4);

        expect(computeManualStages({ status: "issued", createdAt: T0 }).stages[1].at).toBeUndefined();
    });

    it("reports failed, with when when known", () => {
        const withTime = computeManualStages({ status: "failed", createdAt: T0, failedAt: T1 });
        expect(withTime.stage).toBe("failed");
        expect(withTime.stages.map((stage) => stage.state)).toEqual(["done", "failed"]);
        expect(withTime.stages[1].at).toBe(T1);
        expect(withTime.progress).toBe(5);

        expect(computeManualStages({ status: "failed", createdAt: T0 }).stages[1].at).toBeUndefined();
    });
});

describe("classifyOrderFailure()", () => {
    it.each(["rejectedIdentifier", "unsupportedIdentifier", "caa", "badCSR", "badPublicKey", "compound"])(
        "treats %s as a refusal of the request itself - not retryable",
        (name) => {
            expect(classifyOrderFailure({ type: `urn:ietf:params:acme:error:${name}` })).toEqual({ errorCode: "rejected", retryable: false });
        },
    );

    it.each(["unauthorized", "incorrectResponse"])("treats %s as a challenge the CA could not validate - retryable", (name) => {
        expect(classifyOrderFailure({ type: `urn:ietf:params:acme:error:${name}` })).toEqual({ errorCode: "challenge-failed", retryable: true });
    });

    it.each(["serverInternal", "rateLimited", "connection", "dns", "tls"])("treats %s as the CA's own trouble - retryable", (name) => {
        expect(classifyOrderFailure({ type: `urn:ietf:params:acme:error:${name}` })).toEqual({ errorCode: "ca-error", retryable: true });
    });

    it("treats an order with no recognizable problem as invalid but retryable", () => {
        const expected = { errorCode: "order-invalid", retryable: true };
        expect(classifyOrderFailure(undefined)).toEqual(expected);
        expect(classifyOrderFailure({ detail: "test failure" })).toEqual(expected);
        expect(classifyOrderFailure({ type: 42 })).toEqual(expected);
        expect(classifyOrderFailure({ type: "urn:ietf:params:acme:error:somethingNew" })).toEqual(expected);
        expect(classifyOrderFailure({ type: "https://example.com/problem" })).toEqual(expected);
    });
});

describe("classifyTransientFailure()", () => {
    it("blames the reply e-mail when that was the step", () => {
        expect(classifyTransientFailure(new Error("relay down"), "reply")).toEqual({ errorCode: "reply-not-sent", retryable: true });
    });

    it.each(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"])("treats %s from the CA as unreachable", (code) => {
        expect(classifyTransientFailure(Object.assign(new Error("x"), { code }), "ca")).toEqual({ errorCode: "ca-unreachable", retryable: true });
    });

    it("treats an aborted or timed-out request as unreachable", () => {
        expect(classifyTransientFailure(Object.assign(new Error("x"), { name: "AbortError" }), "ca").errorCode).toBe("ca-unreachable");
        expect(classifyTransientFailure(Object.assign(new Error("x"), { name: "TimeoutError" }), "ca").errorCode).toBe("ca-unreachable");
    });

    it("tells a rate limit from any other CA error", () => {
        expect(classifyTransientFailure(Object.assign(new Error("x"), { type: "urn:ietf:params:acme:error:rateLimited" }), "ca")).toEqual({
            errorCode: "rate-limited",
            retryable: true,
        });
        expect(classifyTransientFailure(new Error("500 from the CA"), "ca")).toEqual({ errorCode: "ca-error", retryable: true });
        expect(classifyTransientFailure(undefined, "ca")).toEqual({ errorCode: "ca-error", retryable: true });
    });
});
