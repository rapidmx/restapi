///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ACLAction, type ACLUtils, type RepoUtils } from "@rapidrest/service-core";
import type { EncryptionPolicy, Mailbox, ZeroAccessKey } from "../models/types.js";
import { normalizeUserUid } from "../util/UserUidUtils.js";
import { activeZeroAccessKey, type ZeroAccessStatus } from "../util/ZeroAccessUtils.js";

/** The fixed uid of the one `EncryptionPolicy` row (`BaseEncryptionPolicyRoute`). */
export const ENCRYPTION_POLICY_UID = "encryption-policy";

/** The certificate to encrypt a mailbox's mail to, ready for `ZeroAccessSealer`. */
export interface ZeroAccessTarget {
    key: ZeroAccessKey;
    /** `key.publicKey` decoded: the DER certificate. */
    certDer: Buffer;
}

/** The mailbox fields zero-access decisions read. */
export type ZeroAccessMailbox = Pick<Mailbox, "uid" | "ownerUserUid" | "zeroAccessEnabled" | "zeroAccessKeys">;

function canonicalUserUid(uid: string | undefined): string | undefined {
    const trimmed: string | undefined = uid?.trim();
    return trimmed === undefined ? undefined : (normalizeUserUid(trimmed) ?? trimmed.toLowerCase());
}

/**
 * Decides, from the stored policy and the mailbox's own access list, whether a mailbox's mail is stored zero-access encrypted
 * (`specs/search.md` §3) - the repo-backed counterpart of `util/ZeroAccessUtils.ts`'s pure `zeroAccessStatus()`, which it
 * applies in the same order. Built by each writer of message content (ingest, the scan queue, send, import) from repos it
 * already has.
 */
export class ZeroAccessResolver {
    constructor(
        private readonly policyRepo: RepoUtils<EncryptionPolicy> | undefined,
        private readonly aclUtils: ACLUtils | undefined,
        /** `mail:zero_access:allowed` - the setting until an administrator saves one. */
        private readonly allowedDefault: boolean,
        /** `trusted_roles`: a record for one of these on a mailbox's access list is administration, not delegation. */
        private readonly trustedRoles: readonly string[],
    ) {}

    /** The effective "Allow zero-access encryption": the saved `EncryptionPolicy.allowZeroAccess`, else the server default. */
    public async allowed(): Promise<boolean> {
        const policy: EncryptionPolicy | undefined = await this.policyRepo?.findOne(ENCRYPTION_POLICY_UID, { ignoreACL: true });
        return typeof policy?.allowZeroAccess === "boolean" ? policy.allowZeroAccess : this.allowedDefault !== false;
    }

    /** Whether anybody besides the owner (and administrative roles) holds read access on `mailbox` - a delegate who would lose
     * access to new mail if it were encrypted to the owner's key alone. */
    public async hasDelegates(mailbox: ZeroAccessMailbox): Promise<boolean> {
        const acl = await this.aclUtils?.findACL(mailbox.uid);
        const owner: string | undefined = canonicalUserUid(mailbox.ownerUserUid);
        return (acl?.records ?? []).some(
            (record) =>
                canonicalUserUid(record.userOrRoleId) !== owner &&
                !this.trustedRoles.includes(record.userOrRoleId) &&
                record.actions.some((action) => action === ACLAction.READ || action === ACLAction.FULL),
        );
    }

    /** `zeroAccessStatus()` for `mailbox`, reading the policy and the access list only when an earlier check hasn't decided it. */
    public async status(mailbox: ZeroAccessMailbox): Promise<ZeroAccessStatus> {
        if (!(await this.allowed())) {
            return "disabled_by_admin";
        }
        if (mailbox.zeroAccessEnabled === false) {
            return "disabled_by_owner";
        }
        if (!mailbox.ownerUserUid || (await this.hasDelegates(mailbox))) {
            return "shared_mailbox";
        }
        return activeZeroAccessKey(mailbox) ? "active" : "no_key";
    }

    /** What new mail for `mailbox` must be encrypted to - its active zero-access key - or `undefined` when zero-access isn't
     * active for it, in which case mail is stored as it arrives. */
    public async target(mailbox: ZeroAccessMailbox): Promise<ZeroAccessTarget | undefined> {
        if ((await this.status(mailbox)) !== "active") {
            return undefined;
        }
        return toTarget(activeZeroAccessKey(mailbox)!);
    }
}

function toTarget(key: ZeroAccessKey): ZeroAccessTarget {
    return { key, certDer: Buffer.from(key.publicKey, "base64") };
}

/** The mailbox's zero-access key with `fingerprint` - revoked or not, since mail already decided for it must be encrypted to the
 * key chosen then - or `undefined` when the mailbox has no such key. */
export function zeroAccessTargetFor(mailbox: Pick<Mailbox, "zeroAccessKeys">, fingerprint: string): ZeroAccessTarget | undefined {
    const key: ZeroAccessKey | undefined = (mailbox.zeroAccessKeys ?? []).find((k) => k.fingerprint === fingerprint);
    return key ? toTarget(key) : undefined;
}
