///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { type BaseEntity, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { MailboxPolicy } from "../models/types.js";

/** The fixed identifier of the one `MailboxPolicy` row - same singleton convention as `RETENTION_POLICY_UID`. */
export const MAILBOX_POLICY_UID = "mailbox-policy";

/** The quota a new mailbox gets when config doesn't say otherwise - the admin console's long-standing default. */
export const DEFAULT_MAILBOX_QUOTA_BYTES = 5_000_000_000;

/** The values a deployment's first `MailboxPolicy` row is seeded with - its server config at that moment. */
export interface MailboxPolicySeed {
    defaultQuotaBytes: number;
    autoProvisionEnabled: boolean;
    autoProvisionQuotaBytes: number;
}

/**
 * Returns the singleton row `uid`, creating it from `seed` if it doesn't exist yet. Two concurrent first callers
 * can both miss and both create; the loser's create throws a duplicate-key error, and since the uid is fixed,
 * re-reading and returning the winner's row is the correct outcome (same reasoning as
 * `BaseRetentionPolicyRoute.findOrCreate()`).
 */
export async function findOrCreateSingleton<T extends BaseEntity>(repo: RepoUtils<T>, entityClass: any, uid: string, seed: Record<string, unknown> = {}): Promise<T> {
    const existing: T | undefined = await repo.findOne(uid, { ignoreACL: true });
    if (existing) {
        return existing;
    }
    try {
        return await repo.create(new entityClass({ ...seed, uid }), { ignoreACL: true });
    } catch (err) {
        const winner: T | undefined = await repo.findOne(uid, { ignoreACL: true });
        if (winner) {
            return winner;
        }
        throw err;
    }
}

/**
 * The deployment's mailbox policy, with the server's `mail:*` config (`seed`) used both ways:
 *
 * Seed: the first call creates the row from `seed`, so a deployment's existing configuration carries over into the
 * admin-editable setting, which the admin can then change.
 *
 * Live fallback: any field the row leaves unset takes its `seed` value, and if the row can't be read or created at
 * all (e.g. the datastore is briefly unavailable), the config values are returned as-is, so mailbox creation keeps
 * working rather than failing on a settings lookup.
 */
export async function findOrSeedMailboxPolicy(
    objectFactory: ObjectFactory,
    mailboxPolicyClass: any,
    seed: MailboxPolicySeed,
    logger?: any,
): Promise<MailboxPolicySeed> {
    try {
        const repo: RepoUtils<MailboxPolicy> = await objectFactory.newInstance(RepoUtils, {
            name: mailboxPolicyClass.name,
            args: [mailboxPolicyClass],
        });
        const policy: MailboxPolicy = await findOrCreateSingleton(repo, mailboxPolicyClass, MAILBOX_POLICY_UID, { ...seed });
        return {
            defaultQuotaBytes: policy.defaultQuotaBytes ?? seed.defaultQuotaBytes,
            autoProvisionEnabled: policy.autoProvisionEnabled ?? seed.autoProvisionEnabled,
            autoProvisionQuotaBytes: policy.autoProvisionQuotaBytes ?? seed.autoProvisionQuotaBytes,
        };
    } catch (err: any) {
        logger?.warn(`Could not read the mailbox policy; using server config instead: ${err.message}`);
        return { ...seed };
    }
}
