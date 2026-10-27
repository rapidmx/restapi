///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import type { RepoUtils } from "@rapidrest/service-core";
import { DeploymentIdentity } from "../models/types.js";
import { findOrCreateSingleton } from "./MailboxPolicyUtils.js";

/** The fixed identifier of the one `DeploymentIdentity` row - same singleton convention as `MAILBOX_POLICY_UID`. */
export const DEPLOYMENT_IDENTITY_UID = "deployment-identity";

/** What an `installationId` looks like: 16 lowercase letters and digits, safe in a TXT value, a label and a resource name. */
export const INSTALLATION_ID_PATTERN: RegExp = /^[a-z0-9]{16}$/;

const INSTALLATION_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A new random `installationId` (about 82 bits). */
export function newInstallationId(): string {
    let id = "";
    for (let i = 0; i < 16; i++) {
        id += INSTALLATION_ID_ALPHABET[crypto.randomInt(INSTALLATION_ID_ALPHABET.length)];
    }
    return id;
}

/**
 * This deployment's identity, created with a new `installationId` the first time it is asked for and the same row ever after. Two replicas asking
 * at once both get the winner's row (`findOrCreateSingleton()`). The id is the stable part of the external-dns owner id, so a row whose id isn't
 * one this function would have made (edited by hand, say) is an error rather than something to repair: a new id would orphan every record the
 * deployment owns.
 */
export async function findOrCreateDeploymentIdentity<T extends DeploymentIdentity>(repo: RepoUtils<T>): Promise<T> {
    const identity: T = await findOrCreateSingleton(repo, DEPLOYMENT_IDENTITY_UID, { installationId: newInstallationId() });
    if (typeof identity.installationId !== "string" || !INSTALLATION_ID_PATTERN.test(identity.installationId)) {
        throw new Error("The deployment identity's installationId is malformed; it must be 16 lowercase letters and digits and is never regenerated.");
    }
    return identity;
}
