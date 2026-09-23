///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils } from "@rapidrest/service-core";
import { Mailbox } from "../models/types.js";
import { asEntity } from "./EntityUtils.js";

/** Thrown by `chargeMailboxQuota()` when charging more bytes against a mailbox would exceed its current
 * `quotaBytes`. Callers decide what "can't store this" means for their own write path (reject the request
 * with a 4xx, quarantine the message instead of filing it, stop a bulk import, ...) - this module only ever
 * decides the arithmetic. Carries the fresh `quotaBytes`/`usedBytes` this check was made against, so a
 * caller that keeps its own local cache of them (e.g. `MailboxImportJob`'s `ImportQuota`, for its own cheap
 * pre-check ahead of the next charge) doesn't need a second read just to learn what was just read here. */
export class MailboxQuotaExceededError extends Error {
    public readonly quotaBytes: number;
    public readonly usedBytes: number;

    constructor(message: string, quotaBytes: number, usedBytes: number) {
        super(message);
        this.quotaBytes = quotaBytes;
        this.usedBytes = usedBytes;
    }
}

/** Thrown by `chargeMailboxQuota()`/`refundMailboxQuota()` when `mailboxUid` names no current `Mailbox` row.
 * A distinct type (rather than a plain `Error`) so a caller that wants to treat "mailbox not found"
 * differently from any other charge failure - e.g. `ScanQueueJob`'s inbound delivery, which would rather
 * skip quota enforcement than fail an otherwise-deliverable message outright over it (see
 * `ScanQueueJob.chargeMailboxQuotaForDelivery()`) - can distinguish it with `instanceof` instead of
 * string-matching `message`. */
export class MailboxNotFoundError extends Error {}

/** How many times a `Mailbox.usedBytes` charge/refund is retried on an optimistic-lock conflict. Shared by
 * every caller of `chargeMailboxQuota()`/`refundMailboxQuota()` below. */
const MAX_QUOTA_ATTEMPTS = 5;

/** The result of a successful `chargeMailboxQuota()` call - the mailbox's quota/usage as of the write that
 * just succeeded, so a caller that wants to keep a local cache (to cheaply pre-check a next charge without
 * another read - see `MailboxImportJob`'s own `ImportQuota`) doesn't need a second read to get it. */
export interface MailboxQuotaState {
    quotaBytes: number;
    usedBytes: number;
}

/**
 * Atomically checks and charges `bytes` against `mailboxUid`'s persisted quota: re-reads the mailbox
 * (uncached, so concurrent charges from other writers - an attachment upload racing an inbound delivery,
 * say - are never missed), throws `MailboxQuotaExceededError` if `usedBytes + bytes` would exceed its
 * current `quotaBytes` (`quotaBytes <= 0` means unlimited - the model default of `0` is an unprovisioned
 * quota, not a zero-byte mailbox), and otherwise writes the incremented `usedBytes` with a version-checked
 * update (an unversioned write would silently clobber a concurrent charge from another writer instead of
 * losing the race honestly). A conflict re-reads and retries, up to `MAX_QUOTA_ATTEMPTS`.
 *
 * This is the one place every writer of `Mailbox.usedBytes` should go through -
 * `BaseAttachmentRoute.upload()`, `ScanQueueJob`'s inbound delivery, and `MailboxImportJob`'s own
 * historical-import charging all call this rather than hand-rolling the same re-read/version-check/retry
 * loop three separate times (this function was extracted from what used to be `MailboxImportJob`'s own
 * private `chargeQuota()`).
 */
export async function chargeMailboxQuota<MB extends Mailbox>(
    mailboxRepo: RepoUtils<MB>,
    mailboxUid: string,
    bytes: number,
): Promise<MailboxQuotaState> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_QUOTA_ATTEMPTS; attempt++) {
        const current: MB | undefined = await mailboxRepo.findOne(mailboxUid, { ignoreACL: true, skipCache: true });
        if (!current) {
            throw new MailboxNotFoundError("The target mailbox no longer exists.");
        }
        const quotaBytes: number = current.quotaBytes ?? 0;
        const usedBytes: number = current.usedBytes ?? 0;
        if (quotaBytes > 0 && usedBytes + bytes > quotaBytes) {
            throw new MailboxQuotaExceededError(
                `Storing ${bytes} more bytes would exceed mailbox ${mailboxUid}'s quota of ${quotaBytes} bytes.`,
                quotaBytes,
                usedBytes,
            );
        }
        try {
            await mailboxRepo.update(
                { uid: current.uid, version: (current as any).version, usedBytes: usedBytes + bytes } as any,
                asEntity(mailboxRepo, current),
                { ignoreACL: true, skipPush: true },
            );
            return { quotaBytes, usedBytes: usedBytes + bytes };
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError;
}

/**
 * Best-effort reversal of `chargeMailboxQuota()` for a write that was charged but then failed to actually
 * persist - same versioned re-read/retry loop. Never throws: a refund that can't be written (every attempt
 * conflicts) is reported via `onFailure` rather than thrown, since the caller's own write already failed for
 * its own reason and a failed refund on top of that shouldn't mask it - `MailboxQuotaRecalcJob`'s hourly pass
 * corrects the resulting over-count later. A mailbox that no longer exists has nothing to refund against,
 * which isn't a failure either.
 */
export async function refundMailboxQuota<MB extends Mailbox>(
    mailboxRepo: RepoUtils<MB>,
    mailboxUid: string,
    bytes: number,
    onFailure?: (err: unknown) => void,
): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_QUOTA_ATTEMPTS; attempt++) {
        try {
            const current: MB | undefined = await mailboxRepo.findOne(mailboxUid, { ignoreACL: true, skipCache: true });
            if (!current) {
                return;
            }
            const usedBytes: number = Math.max(0, (current.usedBytes ?? 0) - bytes);
            await mailboxRepo.update(
                { uid: current.uid, version: (current as any).version, usedBytes } as any,
                asEntity(mailboxRepo, current),
                { ignoreACL: true, skipPush: true },
            );
            return;
        } catch (err) {
            lastError = err;
        }
    }
    onFailure?.(lastError);
}
