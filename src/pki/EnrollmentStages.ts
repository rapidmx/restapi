///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { EnrollmentStage, EnrollmentStageStatus } from "./SigningCertificateEnrollment.js";

/**
 * The explicit stage machine behind a signing-certificate enrollment's progress (`EnrollmentProgress`): given the
 * milestones an enrollment has recorded - pure functions, no I/O - it says which stage the enrollment is in, how far
 * along each stage is, and how to classify a failure. Kept apart from `Rfc8823AcmeSigningCertificateEnrollment` so the
 * transitions are unit-tested one by one (`test/pki/EnrollmentStages.test.ts`).
 *
 * ## The RFC 8823 (`email-reply-00`) sequence, as `Rfc8823AcmeSigningCertificateEnrollment` really executes it
 *
 * 1. **`submitted`** - `startEnrollment()` opened an ACME order for the mailbox's address and stored the request. The CA
 * now sends its verification e-mail to that address. (Always done: the record exists.)
 * 2. **`awaiting-challenge`** - waiting for the CA's verification e-mail to reach the mailbox. Done once mail ingest
 * correlated it and `recordChallengeToken()` stored its token (`challengeReceivedAt`).
 * 3. **`challenge-answered`** - the server composes the reply that proves control of the address (`digest`) and sends it,
 * then tells the CA the challenge is ready (`completeChallenge()`); done at `replySentAt`. The background job does
 * this on its next tick after the token is recorded.
 * 4. **`validating`** - the CA checks the reply and validates the authorization. Polled with `getOrder()`; done when the
 * order turns `ready` and the server finalizes it with the CSR (`finalizedAt`).
 * 5. **`issuing`** - the CA signs the certificate (order `processing`); done when the order is `valid` and the
 * certificate has been downloaded (`issuedAt`).
 * 6. **`issued`** - the certificate is stored. (The background job installs it into the mailbox's key vault on its next
 * tick - `installedAt` - which is reported separately.)
 *
 * A stage is `done` when its milestone is recorded OR any later stage's is (so a record written before a timestamp
 * existed still reads correctly), `active` when it is the first not done, `pending` after that, and `failed` for the
 * stage an enrollment that ended in failure had reached.
 */

/** Human-readable label of each stage, in order. */
const STAGE_LABELS: ReadonlyArray<readonly [Exclude<EnrollmentStage, "failed">, string]> = [
    ["submitted", "Request submitted"],
    ["awaiting-challenge", "Verification e-mail sent by the CA"],
    ["challenge-answered", "Verification e-mail answered"],
    ["validating", "CA validating"],
    ["issuing", "Certificate being issued"],
    ["issued", "Certificate issued"],
];

/** `progress` (0..100) while `stage` is the active one. `failed` keeps the value of the stage it failed in. */
const STAGE_PROGRESS: Readonly<Record<Exclude<EnrollmentStage, "failed">, number>> = {
    submitted: 5,
    "awaiting-challenge": 15,
    "challenge-answered": 40,
    validating: 60,
    issuing: 85,
    issued: 100,
};

/** What an RFC 8823 enrollment has recorded, as far as the stage machine is concerned. */
export interface AcmeMilestones {
    status: "pending" | "issued" | "failed";
    /** When the request was submitted. */
    createdAt: string;
    /** The CA's verification e-mail was received and its token recorded (`recordChallengeToken()`). */
    challengeReceivedAt?: string;
    /** Whether the reply digest is known (a record from before `challengeReceivedAt` existed has this but no timestamp). */
    hasDigest: boolean;
    /** The reply was sent and the CA told the challenge is ready. */
    replySentAt?: string;
    /** The order was finalized with the CSR. */
    finalizedAt?: string;
    /** The certificate was downloaded. */
    issuedAt?: string;
    /** The enrollment ended in failure. */
    failedAt?: string;
    /** The last order status the CA reported (`pending`, `ready`, `processing`, `valid`, `invalid`). */
    orderStatus?: string;
}

/** The result of `computeStages()`. */
export interface StageReport {
    /** The stage in progress; `"issued"` or `"failed"` once the enrollment ended. */
    stage: EnrollmentStage;
    stages: EnrollmentStageStatus[];
    /** 0..100. */
    progress: number;
}

/**
 * The stages of an RFC 8823 enrollment as `milestones` place them. See this module's comment for what each milestone means.
 */
export function computeStages(milestones: AcmeMilestones): StageReport {
    const issued: boolean = milestones.status === "issued" || milestones.issuedAt !== undefined;
    const finalized: boolean = issued || milestones.finalizedAt !== undefined || milestones.orderStatus === "processing" || milestones.orderStatus === "valid";
    const answered: boolean = finalized || milestones.replySentAt !== undefined;
    const challengeReceived: boolean = answered || milestones.challengeReceivedAt !== undefined || milestones.hasDigest;
    const done: boolean[] = [true, challengeReceived, answered, finalized, issued, milestones.status === "issued"];
    const at: Array<string | undefined> = [
        milestones.createdAt,
        milestones.challengeReceivedAt,
        milestones.replySentAt,
        milestones.finalizedAt,
        milestones.issuedAt,
        milestones.issuedAt,
    ];

    // The first stage not done - the active one, or, for a failed enrollment, the one it failed in (the last stage when
    // everything had been reached, e.g. an issued certificate that was cancelled before it was installed).
    const firstOpen: number = done.indexOf(false);
    const reached: number = firstOpen === -1 ? STAGE_LABELS.length - 1 : firstOpen;
    const failed: boolean = milestones.status === "failed";

    const stages: EnrollmentStageStatus[] = STAGE_LABELS.map(([id, label], index) => {
        let state: EnrollmentStageStatus["state"];
        if (failed && index === reached) {
            state = "failed";
        } else if (done[index]) {
            state = "done";
        } else if (!failed && index === reached) {
            state = "active";
        } else {
            state = "pending";
        }
        const stamp: string | undefined = state === "failed" ? milestones.failedAt : at[index];
        return { id, label, state, ...(stamp ? { at: stamp } : {}) };
    });
    // Nothing is active once the last stage is done.
    const stage: EnrollmentStage = failed ? "failed" : STAGE_LABELS[reached][0];
    // A failure never reads as complete, even one that struck after the certificate was issued (a cancelled install).
    const progress: number = STAGE_PROGRESS[STAGE_LABELS[reached][0]];
    return { stage, stages, progress: failed ? Math.min(progress, 90) : progress };
}

/**
 * The single-stage report of an enrollment that isn't automated (`ManualSigningCertificateEnrollment`): the request is
 * with an administrator, who obtains the certificate from a CA by hand and uploads it. There is nothing finer to report.
 */
export function computeManualStages(milestones: { status: "pending" | "issued" | "failed"; createdAt: string; issuedAt?: string; failedAt?: string }): StageReport {
    const submittedAt: string = milestones.createdAt;
    if (milestones.status === "pending") {
        return {
            stage: "submitted",
            stages: [{ id: "submitted", label: "Waiting for an administrator to upload the certificate", state: "active", at: submittedAt }],
            progress: STAGE_PROGRESS.submitted,
        };
    }
    const submitted: EnrollmentStageStatus = { id: "submitted", label: "Request submitted", state: "done", at: submittedAt };
    if (milestones.status === "issued") {
        return {
            stage: "issued",
            stages: [submitted, { id: "issued", label: "Certificate issued", state: "done", ...(milestones.issuedAt ? { at: milestones.issuedAt } : {}) }],
            progress: STAGE_PROGRESS.issued,
        };
    }
    return {
        stage: "failed",
        stages: [submitted, { id: "issued", label: "Certificate issued", state: "failed", ...(milestones.failedAt ? { at: milestones.failedAt } : {}) }],
        progress: STAGE_PROGRESS.submitted,
    };
}

/** What a failure means for the person who asked for the certificate. */
export interface FailureClass {
    /** A stable, machine-readable code (kebab-case): `order-expired`, `challenge-failed`, `rejected`, `ca-error`, ... */
    errorCode: string;
    /** Whether starting a new request could reasonably succeed - `false` when the CA refused the request itself (the
     * address, the key or the CSR), which asking again will not change. */
    retryable: boolean;
}

/** ACME problem types (RFC 8555 section 6.7 and RFC 8823) for which the CA has refused the request itself. */
const REFUSED_PROBLEMS: ReadonlySet<string> = new Set([
    "rejectedIdentifier",
    "unsupportedIdentifier",
    "caa",
    "badCSR",
    "badPublicKey",
    "badSignatureAlgorithm",
    "invalidContact",
    "unsupportedContact",
    "compound",
]);

/** ACME problem types for a challenge the CA could not validate (the reply did not verify, or never arrived). */
const CHALLENGE_PROBLEMS: ReadonlySet<string> = new Set(["unauthorized", "incorrectResponse", "badCertificate"]);

/** The short problem name of an ACME error - `"badCSR"` for `"urn:ietf:params:acme:error:badCSR"` - or `undefined`. */
function problemName(error: unknown): string | undefined {
    const type: unknown = (error as { type?: unknown } | undefined)?.type;
    return typeof type === "string" ? type.replace(/^urn:ietf:params:acme:error:/, "") : undefined;
}

/**
 * Classifies the `error` of an ACME order the CA marked `invalid`. A request the CA refused (`rejected`) is not
 * `retryable`; a validation that did not pass (`challenge-failed`), a CA-side hiccup (`ca-error`) or anything the CA did
 * not say (`order-invalid`) is - a fresh request may go differently.
 */
export function classifyOrderFailure(error: unknown): FailureClass {
    const name: string | undefined = problemName(error);
    if (name !== undefined && REFUSED_PROBLEMS.has(name)) {
        return { errorCode: "rejected", retryable: false };
    }
    if (name !== undefined && CHALLENGE_PROBLEMS.has(name)) {
        return { errorCode: "challenge-failed", retryable: true };
    }
    if (name === "serverInternal" || name === "rateLimited" || name === "connection" || name === "dns" || name === "tls") {
        return { errorCode: "ca-error", retryable: true };
    }
    return { errorCode: "order-invalid", retryable: true };
}

/** Network-level failure codes (Node's `err.code`) that mean the CA could not be reached. */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "UND_ERR_CONNECT_TIMEOUT"]);

/**
 * Classifies an error thrown while advancing an enrollment that is still pending - not terminal: the next tick tries
 * again. `phase` is what was being done: sending the reply e-mail, or talking to the CA.
 */
export function classifyTransientFailure(err: unknown, phase: "reply" | "ca"): FailureClass {
    if (phase === "reply") {
        return { errorCode: "reply-not-sent", retryable: true };
    }
    const code: unknown = (err as { code?: unknown } | undefined)?.code;
    const name: unknown = (err as { name?: unknown } | undefined)?.name;
    if ((typeof code === "string" && UNREACHABLE_CODES.has(code)) || name === "AbortError" || name === "TimeoutError") {
        return { errorCode: "ca-unreachable", retryable: true };
    }
    return { errorCode: problemName(err) === "rateLimited" ? "rate-limited" : "ca-error", retryable: true };
}
