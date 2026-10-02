///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";

/** How many enrollments may be pending at once for one identity, and in all. Each one is an order on the deployment's single ACME
 * account (so a flood can exhaust the CA's rate limits for every tenant) and is advanced on every driver tick until it ends; a manual
 * one is a row an administrator has to deal with. */
export const MAX_PENDING_ENROLLMENTS_PER_IDENTITY = 3;
export const MAX_PENDING_ENROLLMENTS = 1000;

/** How many enrollments may be started in a day (every one counts, finished, failed and cancelled included) for one identity, and in
 * all. A cancelled or finished enrollment no longer counts as pending, so without this a mailbox owner could start and cancel in a
 * loop - an order on the deployment's single ACME account each time. */
export const MAX_ENROLLMENTS_PER_IDENTITY_PER_DAY = 10;
export const MAX_ENROLLMENTS_PER_DAY = 500;
const ENROLLMENT_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How long a finished (issued or failed) enrollment record is kept before a new enrollment prunes it. */
export const FINISHED_ENROLLMENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** What the limits read of a stored enrollment. */
interface CountedEnrollment {
    identity: string;
    status: "pending" | "issued" | "failed";
    createdAt: string;
}

/** The refusal for starting another enrollment for `identity` now (too many pending, or too many started in the last day), if due. */
export function enrollmentLimitProblem(store: Record<string, CountedEnrollment>, identity: string, now: number): ApiError | undefined {
    const wanted: string = identity.toLowerCase();
    const all: CountedEnrollment[] = Object.values(store);
    const pending: CountedEnrollment[] = all.filter((enrollment) => enrollment.status === "pending");
    if (
        pending.length >= MAX_PENDING_ENROLLMENTS ||
        pending.filter((enrollment) => enrollment.identity.toLowerCase() === wanted).length >= MAX_PENDING_ENROLLMENTS_PER_IDENTITY
    ) {
        return new ApiError(ApiErrors.INVALID_REQUEST, 409, "Too many certificate requests are already pending for this address. Wait for one to finish.");
    }
    const recent: CountedEnrollment[] = all.filter((enrollment) => Date.parse(enrollment.createdAt) >= now - ENROLLMENT_RATE_WINDOW_MS);
    if (
        recent.length >= MAX_ENROLLMENTS_PER_DAY ||
        recent.filter((enrollment) => enrollment.identity.toLowerCase() === wanted).length >= MAX_ENROLLMENTS_PER_IDENTITY_PER_DAY
    ) {
        return new ApiError(ApiErrors.INVALID_REQUEST, 429, "Too many certificate requests were made for this address today. Try again tomorrow.");
    }
    return undefined;
}

/** Removes from `store` the finished records past `FINISHED_ENROLLMENT_RETENTION_MS`: once their outcome has been collected they are never read again. */
export function pruneFinishedEnrollments(store: Record<string, CountedEnrollment>, now: number): void {
    for (const [id, finished] of Object.entries(store)) {
        if (finished.status !== "pending" && Date.parse(finished.createdAt) < now - FINISHED_ENROLLMENT_RETENTION_MS) {
            delete store[id];
        }
    }
}
