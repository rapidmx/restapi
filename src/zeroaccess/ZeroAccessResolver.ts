///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ACLAction, type ACLUtils, type RepoUtils } from "@rapidrest/service-core";
import type { EncryptionPolicy, Mailbox, ZeroAccessDataType, ZeroAccessKey } from "../models/types.js";
import { normalizeUserUid } from "../util/UserUidUtils.js";
import { activeZeroAccessKey, type ZeroAccessStatus, zeroAccessStatus } from "../util/ZeroAccessUtils.js";

/** The fixed uid of the one `EncryptionPolicy` row (`BaseEncryptionPolicyRoute`). */
export const ENCRYPTION_POLICY_UID = "encryption-policy";

/** The certificate to encrypt a mailbox's mail to, ready for `ZeroAccessSealer`. */
export interface ZeroAccessTarget {
    key: ZeroAccessKey;
    /** `key.publicKey` decoded: the DER certificate. */
    certDer: Buffer;
}

/** The mailbox fields zero-access decisions read. */
export type ZeroAccessMailbox = Pick<Mailbox, "uid" | "ownerUserUid" | "zeroAccessEnabled" | "zeroAccessKeys" | "zeroAccessTypes">;

/** A user uid as member comparisons use it: normalized when it is a UUID, else trimmed and lowercased. */
export function canonicalUserUid(uid: string | undefined): string | undefined {
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
        // Read fresh: one small row, and a stale "allowed" would seal (or not seal) mail against the administrator's current choice.
        const policy: EncryptionPolicy | undefined = await this.policyRepo?.findOne(ENCRYPTION_POLICY_UID, { ignoreACL: true, skipCache: true });
        return typeof policy?.allowZeroAccess === "boolean" ? policy.allowZeroAccess : this.allowedDefault !== false;
    }

    /** The members of `mailbox` besides its owner: every user its access list grants read or full access, other than the owner (however
     * their uid is spelled), administrative roles and the catch-all records. They read its zero-access mail through member key wraps. */
    public async members(mailbox: ZeroAccessMailbox): Promise<{ userUid: string; full: boolean }[]> {
        return zeroAccessMembers(await this.aclUtils?.findACL(mailbox.uid), mailbox, this.trustedRoles);
    }

    /** `zeroAccessStatus()` for `type` (mail unless given) of `mailbox`. */
    public async status(mailbox: ZeroAccessMailbox, type: ZeroAccessDataType = "mail"): Promise<ZeroAccessStatus> {
        return zeroAccessStatus(mailbox, { allowZeroAccess: await this.allowed() }, type);
    }

    /** What new `type` content (mail unless given) of `mailbox` must be encrypted to - its active zero-access key - or `undefined`
     * when zero-access isn't active for it, in which case it is stored as it arrives. */
    public async target(mailbox: ZeroAccessMailbox, type: ZeroAccessDataType = "mail"): Promise<ZeroAccessTarget | undefined> {
        if ((await this.status(mailbox, type)) !== "active") {
            return undefined;
        }
        return toTarget(activeZeroAccessKey(mailbox)!);
    }
}

/** Records that are never a member: the anonymous and catch-all records. */
const NON_MEMBER_RECORDS: ReadonlySet<string> = new Set(["anonymous", ".*"]);

/** `ZeroAccessResolver.members()` over an already-read access list. */
export function zeroAccessMembers(
    acl: { records?: { userOrRoleId: string; actions: string[] }[] } | undefined | null,
    mailbox: Pick<Mailbox, "ownerUserUid">,
    trustedRoles: readonly string[],
): { userUid: string; full: boolean }[] {
    const owner: string | undefined = canonicalUserUid(mailbox.ownerUserUid);
    const members: Map<string, boolean> = new Map();
    for (const record of acl?.records ?? []) {
        const uid: string | undefined = canonicalUserUid(record.userOrRoleId);
        if (!uid || uid === owner || NON_MEMBER_RECORDS.has(record.userOrRoleId) || trustedRoles.includes(record.userOrRoleId)) {
            continue;
        }
        const full: boolean = record.actions.includes(ACLAction.FULL);
        if (full || record.actions.includes(ACLAction.READ)) {
            members.set(uid, (members.get(uid) ?? false) || full);
        }
    }
    return [...members.entries()].map(([userUid, full]) => ({ userUid, full }));
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
