///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { zBase32Encode } from "./KeyDiscoveryClient.js";

/**
 * The OpenPGP Web Key Directory hash of a local part (draft-koch-openpgp-webkey-service §3.1): the local part with ASCII
 * letters lowercased, hashed with SHA-1 and z-base-32 encoded (32 characters). Not the RapidMX discovery hash, which is
 * SHA-256 (`computeKeyDiscoveryHash()`).
 */
export function computeWkdHash(localPart: string): string {
    const lowered: string = localPart.replace(/[A-Z]/g, (c) => c.toLowerCase());
    return zBase32Encode(crypto.createHash("sha1").update(lowered, "utf8").digest());
}

const WKD_HASH_PATTERN = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{32}$/;

/** Whether `hash` has the shape of a WKD hash. */
export function isValidWkdHash(hash: unknown): hash is string {
    return typeof hash === "string" && WKD_HASH_PATTERN.test(hash);
}
