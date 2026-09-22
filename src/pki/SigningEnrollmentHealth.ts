///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { lockKeyForPath, readFileIfExists, withLock, writeFileAtomic } from "./FileStoreUtils.js";
import type { SigningEnrollmentHealthReport } from "./SigningCertificateEnrollment.js";

/** The longest error text kept or reported (characters). */
export const MAX_HEALTH_ERROR_LENGTH = 300;

/**
 * An error's text made safe to store and show to any signed-in user: no URLs (which can carry tokens and account ids - only the host
 * is kept), no PEM blocks, no long token-like runs (a JWS, a key, a nonce), no `Bearer` credentials, whitespace collapsed, capped at
 * `MAX_HEALTH_ERROR_LENGTH`. Never throws; anything that isn't text becomes a generic sentence.
 */
export function sanitizeErrorText(error: unknown): string {
    let text: string = typeof error === "string" ? error : typeof (error as any)?.message === "string" ? (error as any).message : "";
    text = text
        .replace(/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g, "[key material removed]")
        .replace(/\b[a-z][a-z0-9+.-]*:\/\/([^\s/?#"'<>)]*)[^\s"'<>)]*/gi, (_match: string, host: string) => (host ? `[url ${host.replace(/^[^@]*@/, "")}]` : "[url]"))
        .replace(/\bBearer\s+\S+/gi, "Bearer [removed]")
        .replace(/\b[A-Za-z0-9_+/=-]{32,}\b/g, "[removed]")
        .replace(/\s+/g, " ")
        .trim();
    if (text === "") {
        return "The certificate authority could not be reached.";
    }
    return text.length > MAX_HEALTH_ERROR_LENGTH ? `${text.slice(0, MAX_HEALTH_ERROR_LENGTH - 1)}…` : text;
}

/** What the file keeps. */
interface HealthRecord {
    lastCheckedAt?: string;
    lastSuccessAt?: string;
    lastError?: { message: string; code?: string; at: string };
    /** Failed contacts in a row since the last success. */
    consecutiveFailures: number;
    firstFailureAt?: string;
    /** Whether the audit entry for the current run of failures was already written (so it is written once, not every tick). */
    streakAudited?: boolean;
}

/** What `SigningEnrollmentHealth.record()` tells its caller (the background job) to do about an outcome. */
export interface HealthUpdate {
    /** How many contacts in a row have failed now (0 after a success). */
    consecutiveFailures: number;
    /** A failure that is the first of a run, or whose text differs from the previous failure's: worth one warning line. */
    newFailure: boolean;
    /** A success right after failures: worth one line saying the CA is back. */
    recovered: boolean;
    /** The run of failures reached the audit threshold and its entry is not written yet - the caller writes it (this is returned once). */
    auditDue: boolean;
    /** The sanitized text of the failure. */
    error?: string;
    /** When the current run of failures began (ISO 8601). */
    firstFailureAt?: string;
}

/**
 * How the CA contacts of an RFC 8823 deployment have gone: the last time the CA answered as it should, the last error (sanitized) and the
 * length of the current run of failures. Kept in memory and in a small JSON file in the enrollment store directory, so it survives a
 * restart and is one view for every process sharing the volume; `AcmeEnrollmentDriverJob` and `startEnrollment()` write it, `GET
 * /system/signing-enrollment` reads it. Best-effort by design: a failure to write it never fails what is being reported on.
 */
export class SigningEnrollmentHealth {
    private memory: HealthRecord = { consecutiveFailures: 0 };

    /** @param filePath Where the record lives (`health.json` in the store directory) - a function, since the directory is configuration. */
    constructor(private readonly filePath: () => string) {}

    private async read(): Promise<HealthRecord> {
        try {
            const raw: string | undefined = await readFileIfExists(this.filePath());
            if (raw !== undefined) {
                const parsed: any = JSON.parse(raw);
                if (parsed && typeof parsed === "object") {
                    return { consecutiveFailures: 0, ...parsed };
                }
            }
        } catch {
            // Unreadable or torn: what this process remembers is the next best thing.
        }
        return { ...this.memory };
    }

    /**
     * Records the outcome of one contact with the CA and says what the caller should do about it.
     *
     * @param outcome `{ ok: true }`, or `{ ok: false, error, code? }` for a failure.
     * @param options.auditAfter The run of failures that makes an audit entry due (`auditDue`); omit for a caller that never audits.
     */
    public async record(
        outcome: { ok: true } | { ok: false; error: unknown; code?: string },
        options: { auditAfter?: number; now?: Date } = {},
    ): Promise<HealthUpdate> {
        const now: string = (options.now ?? new Date()).toISOString();
        return withLock(lockKeyForPath(this.filePath()), async () => {
            const current: HealthRecord = await this.read();
            let update: HealthUpdate;
            if (outcome.ok) {
                update = { consecutiveFailures: 0, newFailure: false, recovered: current.consecutiveFailures > 0, auditDue: false };
                current.lastSuccessAt = now;
                current.consecutiveFailures = 0;
                delete current.lastError;
                delete current.firstFailureAt;
                delete current.streakAudited;
            } else {
                const error: string = sanitizeErrorText(outcome.error);
                const newFailure: boolean = current.consecutiveFailures === 0 || current.lastError?.message !== error;
                current.consecutiveFailures += 1;
                current.firstFailureAt ??= now;
                current.lastError = { message: error, at: now, ...(outcome.code ? { code: outcome.code } : {}) };
                const auditDue: boolean = options.auditAfter !== undefined && current.consecutiveFailures >= options.auditAfter && !current.streakAudited;
                if (auditDue) {
                    current.streakAudited = true;
                }
                update = { consecutiveFailures: current.consecutiveFailures, newFailure, recovered: false, auditDue, error, firstFailureAt: current.firstFailureAt };
            }
            current.lastCheckedAt = now;
            this.memory = current;
            try {
                await writeFileAtomic(this.filePath(), JSON.stringify(current), 0o600, 0o700);
            } catch {
                // Best-effort: the in-memory copy still answers in this process.
            }
            return update;
        });
    }

    /** The health as the info endpoint reports it: `{ ok: true }` with no times when the CA has never been contacted (nothing is known to be wrong). */
    public async report(): Promise<SigningEnrollmentHealthReport> {
        const current: HealthRecord = await this.read();
        return {
            ok: current.consecutiveFailures === 0,
            ...(current.lastCheckedAt ? { checkedAt: current.lastCheckedAt } : {}),
            ...(current.lastSuccessAt ? { lastSuccessAt: current.lastSuccessAt } : {}),
            ...(current.lastError ? { lastError: sanitizeErrorText(current.lastError.message) } : {}),
        };
    }
}
