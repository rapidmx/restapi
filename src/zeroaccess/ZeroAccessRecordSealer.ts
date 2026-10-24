///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { ACLUtils, type ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import type { Mailbox, ZeroAccessDataType } from "../models/types.js";
import { PROTECTED_TEXT, type ProtectedField, sealFieldsOnWrite } from "./ZeroAccessFieldSealer.js";
import { type ZeroAccessMailbox, ZeroAccessResolver } from "./ZeroAccessResolver.js";
const { Config, Inject } = ObjectDecorators;

/** What a protected task's title shows while it is sealed. */
export const PROTECTED_TASK_TITLE = "Protected task";

/** A task's protected fields (`specs/search.md` §3 *What It Covers*): its title and notes. */
export const TASK_PROTECTED_FIELDS: readonly ProtectedField[] = [
    { name: "title", placeholder: () => PROTECTED_TASK_TITLE },
    { name: "body", placeholder: () => null },
];

/** The protected fields of each data type that is sealed field by field. Mail is sealed whole (`ZeroAccessWriter`). */
export const PROTECTED_FIELDS: Readonly<Partial<Record<ZeroAccessDataType, readonly ProtectedField[]>>> = {
    tasks: TASK_PROTECTED_FIELDS,
};

/** Re-exported so writers outside restapi (activesync, mapi) reach the placeholder without importing the field sealer. */
export { PROTECTED_TEXT };

/**
 * Seals calendar events, contacts and tasks on every write, whoever writes them - REST routes, ActiveSync, Outlook (MAPI), plugins and the
 * server itself (`specs/search.md` §3 *What It Covers*): `sealWrite()` applies `sealFieldsOnWrite()` with the type's protected fields and
 * the mailbox's zero-access key when that type is protected for it. One per backend (`newZeroAccessRecordSealer()`).
 */
export class ZeroAccessRecordSealer {
    @Inject(ACLUtils)
    protected aclUtils?: ACLUtils;

    @Config("trusted_roles", ["admin"])
    protected trustedRoles: string[] = ["admin"];

    @Config("mail:zero_access:allowed", true)
    protected allowedDefault: boolean = true;

    constructor(protected readonly policyRepo: RepoUtils<any> | undefined) {}

    /**
     * Applies a create (`existing` undefined) or update `patch` of a `type` record of `mailbox` in place, sealing its protected fields when
     * `type` is protected for the mailbox and storing them readable otherwise - see `sealFieldsOnWrite()`. A type without protected fields
     * leaves the patch alone.
     */
    public async sealWrite(
        type: ZeroAccessDataType,
        mailbox: (Pick<Mailbox, "uid"> & ZeroAccessMailbox) | undefined,
        patch: Record<string, any>,
        existing?: Record<string, any>,
    ): Promise<void> {
        const fields: readonly ProtectedField[] | undefined = PROTECTED_FIELDS[type];
        if (!fields) {
            return;
        }
        const target = mailbox
            ? await new ZeroAccessResolver(this.policyRepo, this.aclUtils, this.allowedDefault, this.trustedRoles).target(mailbox, type)
            : undefined;
        await sealFieldsOnWrite(patch, existing, fields, target);
    }
}

/** The `ZeroAccessRecordSealer` of a backend, or `undefined` without its `EncryptionPolicy` model (nothing is sealed then). */
export async function newZeroAccessRecordSealer(objectFactory: ObjectFactory, encryptionPolicyClass: any): Promise<ZeroAccessRecordSealer | undefined> {
    if (!encryptionPolicyClass) {
        return undefined;
    }
    const policyRepo: RepoUtils<any> = await objectFactory.newInstance(RepoUtils, { name: encryptionPolicyClass.name, args: [encryptionPolicyClass] });
    return await objectFactory.newInstance(ZeroAccessRecordSealer, { name: `ZeroAccessRecordSealer:${encryptionPolicyClass.name}`, args: [policyRepo] });
}
