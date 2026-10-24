///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { RepoUtils } from "@rapidrest/service-core";
import type { EncryptionPolicy } from "../models/types.js";
import { ENCRYPTION_POLICY_UID } from "../zeroaccess/ZeroAccessResolver.js";

/** The config key seeding `EncryptionPolicy.allowOpenPgp` until an administrator saves a value. */
export const OPENPGP_ALLOWED_CONFIG = "mail:encryption:openpgp_allowed";

/**
 * "Allow OpenPGP" (`EncryptionPolicy.allowOpenPgp`, `specs/end-to-end_encryption.md` *OpenPGP Interoperability*): whether
 * mailboxes on this server may enroll and publish OpenPGP keys. Off, enrollment refuses one and the public discovery
 * endpoints leave published ones out; S/MIME is unaffected.
 */
export class OpenPgpPolicy {
    constructor(
        private readonly policyRepo: RepoUtils<EncryptionPolicy> | undefined,
        /** `mail:encryption:openpgp_allowed` - the setting until an administrator saves one. */
        private readonly allowedDefault: boolean,
    ) {}

    /** The saved `EncryptionPolicy.allowOpenPgp`, else the server default. Read fresh: one small row. */
    public async allowed(): Promise<boolean> {
        const policy: EncryptionPolicy | undefined = await this.policyRepo?.findOne(ENCRYPTION_POLICY_UID, { ignoreACL: true, skipCache: true });
        return typeof policy?.allowOpenPgp === "boolean" ? policy.allowOpenPgp : this.allowedDefault !== false;
    }
}
