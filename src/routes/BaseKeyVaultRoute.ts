///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The consuming application must apply `@Route("/mailbox")` to its own concrete subclass (see
// `BaseMailIngestRoute`'s identical note) - every method here is defined relative to that, e.g.
// `@Get("/:id/keyvault")` resolves to `GET /mailbox/:id/keyvault`.
import * as crypto from "crypto";
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import {
    ACLAction,
    ACLUtils,
    ApiErrorMessages,
    ApiErrors,
    DatabaseDecorators,
    HttpResponse,
    ObjectFactory,
    RepoUtils,
    RouteDecorators,
} from "@rapidrest/service-core";
import { EncryptionCertificateAuthority } from "../pki/EncryptionCertificateAuthority.js";
import {
    EnrollmentBinding,
    EnrollmentProgress,
    EnrollmentSummary,
    providerKindOf,
    SIGNING_ENROLLMENT_UNKNOWN,
    SigningCertificateEnrollment,
} from "../pki/SigningCertificateEnrollment.js";
import { normalizeAddress } from "../util/AddressUtils.js";
import { AuditLogUtils } from "../util/AuditLogUtils.js";
import {
    publicKeyFromCertificatePem,
    REVOCATION_REASONS,
    revokeInactiveKeys,
    supersedeKeys,
    verifiedIssuerCertificate,
} from "../util/CertificateInstallUtils.js";
import { asEntity } from "../util/EntityUtils.js";
import { AuditAction, EncryptionPolicy, EscrowScope, KeyUseType, KeyVault, Mailbox, MasterKeyWrap, MemberKeyWrap, PublicKey, WrappedPrivateKey, ZeroAccessEscrowWrap, ZeroAccessKey } from "../models/types.js";
import { activeZeroAccessKey, settleZeroAccessTypes } from "../util/ZeroAccessUtils.js";
import { canonicalUserUid, zeroAccessMembers } from "../zeroaccess/ZeroAccessResolver.js";
import { isSealedToCertificate } from "../zeroaccess/ZeroAccessSealer.js";
import { isOpenPgpKey, OPENPGP_KEY_TYPE, parseOpenPgpContactKey } from "../util/OpenPgpKeyUtils.js";
import { OPENPGP_ALLOWED_CONFIG, OpenPgpPolicy } from "../util/OpenPgpPolicy.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;
const { Transactional } = DatabaseDecorators;
const { Delete, Get, Param, Post, Put, Query, Response, User: AuthUser } = RouteDecorators;

/** The wire shape `GET /mailbox/:id/keyvault` returns - identical to the `KeyVault` entity minus its own
 * bookkeeping fields (`uid`/`mailboxUid`/etc.), matching `specs/end-to-end_encryption.md`'s own `KeyVault`
 * type exactly. */
export type PublicKeyVault = Pick<KeyVault, "wrappedKeys" | "masterKeyWraps"> & {
    /** How many times the vault's master key has been rotated (`0` for never, and for no vault yet). A client sends it
     * back as `expectedMasterKeyGeneration` on the writes that put material sealed under its master key into the vault
     * (see `ExpectedMasterKeyGeneration`). */
    masterKeyGeneration: number;
    /** The mailbox's zero-access certificates (`Mailbox.zeroAccessKeys`, `[]` for none). Returned here, to the vault's reader only,
     * because unlocking needs them (CMS addresses its recipient by certificate) and they are never published. */
    zeroAccessKeys: ZeroAccessKey[];
};


/** The most member key wraps one vault holds (members times retained keys). */
const MAX_MEMBER_KEY_WRAPS = 2000;

/** The most escrow copies of zero-access keys one vault holds (keys times the scopes a mailbox was assigned to over time). */
const MAX_ESCROW_ZERO_ACCESS_WRAPS = 200;

/** An escrow copy of a zero-access key as a client sends it (`escrowKeyFingerprint` and `createdAt` are the server's). */
export type ZeroAccessEscrowWrapInput = Pick<ZeroAccessEscrowWrap, "escrowScopeId" | "zeroAccessKeyFingerprint" | "cms">;

/** A member key wrap as a client sends it (`createdAt` is the server's). */
export type MemberKeyWrapInput = Omit<MemberKeyWrap, "createdAt">;

/** One member of a shared mailbox in `SharedKeyStatus`. */
export interface SharedKeyMember {
    userUid: string;
    /** Full access: may provision, rotate and fulfil wraps. */
    full: boolean;
    /** The member's own zero-access certificate - what their wraps are addressed to. Absent until they first sign in and get one. */
    certificate?: ZeroAccessKey;
    /** The fingerprints of this mailbox's zero-access keys the member holds a wrap of. */
    wrapped: string[];
}

/** `GET /mailbox/:id/keyvault/members` - see `BaseKeyVaultRoute.memberKeyStatus()`. */
export interface SharedKeyStatus {
    ownerless: boolean;
    /** The caller: the mailbox's owner, one of its members (who reads it through member key wraps), or neither (an administrator acting
     * through a role record) - so a client knows whether to unlock it with its own password or its wraps. */
    role: "owner" | "member" | "other";
    activeKeyFingerprint?: string;
    zeroAccessKeys: ZeroAccessKey[];
    members: SharedKeyMember[];
    /** Members with a certificate but no wrap of the active key: a client holding the key wraps it for them. */
    pending: string[];
    /** Users holding wraps who are no longer members: their wraps are removed after a rotation. */
    departed: string[];
    /** A departed user holds the active key: a new key must be provisioned for the remaining members. */
    rotationPending: boolean;
    /** The caller may change the wraps (the owner, or a member with full access). */
    manager: boolean;
    /** A mailbox without an owner assigned to an escrow scope: that scope. Its certificate comes from the mailbox's escrow info. */
    escrowScopeId?: string;
    /** The fingerprints of this mailbox's zero-access keys with no escrow copy for `escrowScopeId` yet: a client holding the keys wraps
     * them to the scope's certificate (`putZeroAccessEscrowWraps()`). Always empty for a mailbox with an owner, whose escrowed master
     * key already opens them. */
    escrowPending: string[];
}

const EMPTY_KEY_VAULT: PublicKeyVault = { wrappedKeys: [], masterKeyWraps: [], masterKeyGeneration: 0, zeroAccessKeys: [] };

/**
 * Optional on `enrollKey()`, `startSignEnrollment()`, `addMasterKeyWrap()` and `rekey()`: the `masterKeyGeneration` the
 * client read with the vault whose master key it sealed the request's key material under (a wrapped private key, or the
 * master key itself in a new wrap). When given and the vault has moved on - another device rotated the master key
 * since - the request is refused with `409` instead of installing material nobody can open with the current master key.
 * Omitted, the request is accepted as before (older clients). Must be a non-negative integer (`400` otherwise).
 */
export interface ExpectedMasterKeyGeneration {
    expectedMasterKeyGeneration?: number;
}

/** The vault's current master key generation (`0` for none recorded, or no vault). */
function generationOf(keyVault: KeyVault | undefined): number {
    return keyVault?.masterKeyGeneration ?? 0;
}

/** Validates an `expectedMasterKeyGeneration` from a request body (`400` unless absent or a non-negative integer). */
function readExpectedGeneration(body: unknown): number | undefined {
    const value: unknown = (body as ExpectedMasterKeyGeneration | undefined)?.expectedMasterKeyGeneration;
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "expectedMasterKeyGeneration must be a non-negative integer.");
    }
    return value;
}

/** Refuses (409) a request whose `expected` generation isn't the vault's current one - see `ExpectedMasterKeyGeneration`. */
function assertMasterKeyGeneration(keyVault: KeyVault | undefined, expected: number | undefined): void {
    if (expected !== undefined && expected !== generationOf(keyVault)) {
        throw new ApiError(
            ApiErrors.IDENTIFIER_EXISTS,
            409,
            "This mailbox's master key was rotated since this key material was sealed - reload the key vault, unlock it again and retry.",
        );
    }
}

/** The response shape of every key-vault endpoint. */
function toPublicKeyVault(keyVault: KeyVault, mailbox: Pick<Mailbox, "zeroAccessKeys">): PublicKeyVault {
    return {
        wrappedKeys: keyVault.wrappedKeys,
        masterKeyWraps: keyVault.masterKeyWraps,
        masterKeyGeneration: generationOf(keyVault),
        zeroAccessKeys: mailbox.zeroAccessKeys ?? [],
    };
}

/** Request body for `enrollKey()`. `wrappedKey`'s `fingerprint`/`useType` are deliberately omitted - the
 * server derives both from the actual issued/validated certificate, never trusting a client-asserted value
 * for either (see `enrollKey()`'s own doc comment). `masterKeyWraps` bootstraps the mailbox's master key, so it is
 * only accepted the very first time a mailbox enrolls a key at all: sent to a vault that already holds wraps or
 * wrapped keys it is a `409` (another enrollment - e.g. a second tab setting up at the same time - got there first,
 * with a different master key). Enrolling an additional key omits it; adding a master-key wrap independent of key
 * enrollment is `addMasterKeyWrap()`'s (D3's) job. */
export interface EnrollKeyRequest extends ExpectedMasterKeyGeneration {
    useType: KeyUseType;
    /** A PEM-encoded PKCS#10 CSR - required, and only meaningful, when `useType` is `"encrypt"` or `"zero-access"`: the
     * server calls the injected `EncryptionCertificateAuthority` itself to mint the certificate. */
    csr?: string;
    /** An already-issued PEM certificate - required, and only meaningful, when `useType` is `"sign"`: signing
     * certificates are enrolled asynchronously against a public CA via the separate
     * `SigningCertificateEnrollment` flow (`startEnrollment()`/`checkStatus()`), which has already completed
     * by the time this call is made - this endpoint only validates and installs the result. */
    certificate?: string;
    /** `"openpgp"` to enroll an OpenPGP key (`useType: "encrypt"` only): the client generated and self-certified it, so it
     * needs no CA - `publicKey` is the certificate and `wrappedKey` its secret key, sealed under the master key. */
    type?: string;
    /** The OpenPGP public key (ASCII armored, or base64 binary) - required, and only meaningful, with `type: "openpgp"`. */
    publicKey?: string;
    wrappedKey: Omit<WrappedPrivateKey, "fingerprint" | "useType" | "type">;
    masterKeyWraps?: MasterKeyWrap[];
}

/** Request body for `addMasterKeyWrap()`: the wrap itself, plus the optional `expectedMasterKeyGeneration` (never
 * stored with the wrap). */
export type AddMasterKeyWrapRequest = MasterKeyWrap & ExpectedMasterKeyGeneration;

/** Request body for `startSignEnrollment()`. `wrappedKey` is submitted upfront, alongside the CSR, so a
 * driver job (a real `SigningCertificateEnrollment` implementation may support one - see that method's
 * own doc comment) can auto-install the finished certificate the moment the CA issues it, with no further
 * client action - the same E2E boundary `EnrollKeyRequest.wrappedKey` already keeps (this server never
 * sees an unwrapped private key). `fingerprint`/`useType` are omitted for the identical reason
 * `EnrollKeyRequest`'s own field omits them: the server derives both from the certificate once it exists,
 * never trusting a client-asserted value for either. */
export interface SignEnrollmentRequest extends ExpectedMasterKeyGeneration {
    /** A PEM-encoded PKCS#10 CSR for the signing key pair to enroll. */
    csr: string;
    wrappedKey: Omit<WrappedPrivateKey, "fingerprint" | "useType">;
}

const MASTER_KEY_WRAP_METHODS = ["password", "passkey", "recovery", "escrow"] as const;

/** Generous enough for any real AEAD ciphertext/nonce/salt/KDF-params string this deployment will ever
 * produce, small enough to block a denial-of-service-sized blob from being stored as a "wrap". */
const MAX_WRAP_FIELD_LENGTH = 8192;

/** Bounds how many enrolled keys/wraps a single mailbox can accumulate - without this, a caller with only
 * ordinary mailbox `UPDATE` access could repeatedly call `enrollKey()`/`addMasterKeyWrap()` to grow
 * `Mailbox.keys`/`KeyVault.wrappedKeys`/`KeyVault.masterKeyWraps` without limit, eventually hitting (and
 * permanently breaking further updates to) MongoDB's 16MB document size limit. Generous enough for any real
 * deployment's key-rotation history. */
const MAX_ENROLLED_KEYS = 50;
const MAX_MASTER_KEY_WRAPS = 20;

/** The most keys one `recordExport()` call may list: the client's cap of 21 zero-access and 21 encryption keys, plus a signing key. */
const MAX_EXPORTED_KEYS = 43;
const EXPORTED_KEY_KINDS: readonly string[] = ["zero-access", "encrypt", "sign"];

/** `POST /mailbox/:id/keyvault/exports`: the keys an "Export keys for Outlook/phone" file held (see `recordExport()`). */
export interface KeyExportRecord {
    keys: { kind: "zero-access" | "encrypt" | "sign"; fingerprint: string }[];
}

/**
 * Validates a client-supplied `MasterKeyWrap` shape before it's persisted - `addMasterKeyWrap()`/`rekey()`
 * previously accepted the request body completely unvalidated (no `method` check, no field presence/type/size
 * check), so any authenticated mailbox owner/delegate could store an arbitrary blob as a "wrap", or falsely
 * assert `method: "escrow"` to manipulate the public discovery endpoint's `escrow` flag (see `allowEscrow`).
 *
 * `allowEscrow: false` additionally rejects `method: "escrow"` outright. `specs/end-to-end_encryption.md`'s
 * Escrow Scoping section requires escrow to be a distinct, separately-granted compliance role - "A user with
 * ... the administrative role in RapidMX MUST NOT thereby be able to decrypt mail" - so the ordinary mailbox
 * owner/delegate path must never be able to add, remove, or fake an escrow wrap itself. `enrollKey()`/
 * `addMasterKeyWrap()` pass `allowEscrow: true` only when `resolveAllowEscrow()` confirms the wrap's own
 * `escrowScopeId` matches the mailbox's actually-assigned `Mailbox.escrowScopeId` and that `EscrowScope`
 * still exists - see that method's own doc comment. `rekey()` applies the same rule to the escrow wraps it replaces
 * the vault's with (see `assertEscrowCarriedOver()`).
 */
function validateMasterKeyWrap(wrap: MasterKeyWrap, { allowEscrow }: { allowEscrow: boolean }): void {
    if (!wrap || !MASTER_KEY_WRAP_METHODS.includes(wrap.method)) {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `method must be one of: ${MASTER_KEY_WRAP_METHODS.join(", ")}.`);
    }
    if (wrap.method === "escrow" && !allowEscrow) {
        throw new ApiError(
            ApiErrors.AUTH_PERMISSION_FAILURE,
            403,
            "Escrow wraps are managed by the compliance/eDiscovery role and cannot be set through this endpoint.",
        );
    }
    for (const field of ["ciphertext", "nonce", "salt", "kdf"] as const) {
        const value: unknown = wrap[field];
        if (typeof value !== "string" || value.length === 0 || value.length > MAX_WRAP_FIELD_LENGTH) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `${field} must be a non-empty string of at most ${MAX_WRAP_FIELD_LENGTH} characters.`);
        }
    }
    if (typeof wrap.schemeVersion !== "number" || !Number.isFinite(wrap.schemeVersion)) {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "schemeVersion must be a number.");
    }
    if (wrap.methodId !== undefined && (typeof wrap.methodId !== "string" || wrap.methodId.length > MAX_WRAP_FIELD_LENGTH)) {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "methodId must be a string.");
    }
}

/** Validates a client-supplied `WrappedPrivateKey`'s wire fields before it's persisted - mirrors
 * `validateMasterKeyWrap()`'s own reasoning: without this, `enrollKey()`/`rekey()` accepted the wrapped-key
 * blob completely unvalidated (no field presence/type/size check at all), the same gap that function's own
 * doc comment describes for `MasterKeyWrap`. */
function validateWrappedPrivateKey(key: Pick<WrappedPrivateKey, "ciphertext" | "nonce" | "algorithm">): void {
    for (const field of ["ciphertext", "nonce", "algorithm"] as const) {
        const value: unknown = key?.[field];
        if (typeof value !== "string" || value.length === 0 || value.length > MAX_WRAP_FIELD_LENGTH) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `${field} must be a non-empty string of at most ${MAX_WRAP_FIELD_LENGTH} characters.`);
        }
    }
}

/** `wrap` reduced to `MasterKeyWrap`'s own fields (the validator only looks at the named ones, and the rest of a body would otherwise be stored
 * as it came), with a `createdAt` that is a number or else now. */
function pickMasterKeyWrap(wrap: MasterKeyWrap): MasterKeyWrap {
    return {
        method: wrap.method,
        ...(wrap.methodId !== undefined ? { methodId: wrap.methodId } : {}),
        ...(typeof wrap.escrowScopeId === "string" ? { escrowScopeId: wrap.escrowScopeId } : {}),
        ciphertext: wrap.ciphertext,
        nonce: wrap.nonce,
        salt: wrap.salt,
        kdf: wrap.kdf,
        schemeVersion: wrap.schemeVersion,
        createdAt: typeof wrap.createdAt === "number" && Number.isFinite(wrap.createdAt) ? wrap.createdAt : Date.now(),
    };
}

/** `key` reduced to `WrappedPrivateKey`'s own fields - see `pickMasterKeyWrap()`. */
function pickWrappedKey(key: WrappedPrivateKey): WrappedPrivateKey {
    return {
        ciphertext: key.ciphertext,
        nonce: key.nonce,
        algorithm: key.algorithm,
        fingerprint: key.fingerprint,
        useType: key.useType,
        ...(isOpenPgpKey(key) ? { type: OPENPGP_KEY_TYPE } : {}),
    };
}

/** Refuses (409) bootstrap `masterKeyWraps` for a vault that is already set up - holding wraps or wrapped keys. They
 * would be silently ignored while the new key (sealed under the caller's master key) was still appended and published,
 * leaving the active key under a master key no stored wrap opens: what two tabs setting up keys at once used to do. */
function assertMasterKeyWrapsAccepted(keyVault: KeyVault | undefined, masterKeyWraps: MasterKeyWrap[] | undefined): void {
    if (!masterKeyWraps?.length || !keyVault) {
        return;
    }
    if ((keyVault.masterKeyWraps ?? []).length > 0 || (keyVault.wrappedKeys ?? []).length > 0) {
        throw new ApiError(
            ApiErrors.IDENTIFIER_EXISTS,
            409,
            "This mailbox's key vault is already set up - enroll additional keys without masterKeyWraps, under its existing master key.",
        );
    }
}

/**
 * The key `rekey()` publishes for `existing` (the stored key a request entry matched): the stored fields, including
 * `issuerCertificate`. Extra request fields are not stored.
 *
 * - A stored `revokedAt` is kept (a revocation peers may already have acted on is never withdrawn); otherwise the
 * request's `revokedAt`, when it sets one, is applied.
 * - `revocationReason` only matters on a revoked key. A key the request newly revokes takes the request's reason, or
 * `"compromised"` when it gives none (an explicit revoke means "do not trust this key"). An already revoked key keeps
 * its reason, except that the request may escalate `"superseded"` to `"compromised"` - never the other way.
 */
function rekeyedKey(existing: PublicKey, requested: { revokedAt?: number; revocationReason?: PublicKey["revocationReason"] }): PublicKey {
    const key: PublicKey = { ...existing };
    if (existing.revokedAt) {
        if (existing.revocationReason === "superseded" && requested.revocationReason === "compromised") {
            key.revocationReason = "compromised";
        }
    } else if (requested.revokedAt) {
        key.revokedAt = requested.revokedAt;
        key.revocationReason = requested.revocationReason ?? "compromised";
    } else {
        delete key.revocationReason;
    }
    return key;
}

/** Request body for `rekey()` - a full, atomic replacement of a mailbox's entire key-vault contents, following
 * the client's own re-key operation (see `MasterKeyWrap`'s doc comment on why removing a wrap alone never
 * revokes access). */
export interface RekeyRequest extends ExpectedMasterKeyGeneration {
    wrappedKeys: WrappedPrivateKey[];
    masterKeyWraps: MasterKeyWrap[];
    /** The mailbox's replacement `PublicKey` list, published alongside the re-keyed vault - a re-key is
     * usually, though not necessarily, paired with fresh key material. */
    keys: PublicKey[];
}

/**
 * Implements `specs/end-to-end_encryption.md`'s key-vault endpoints (`GET`/enroll/wrap-CRUD/re-key under
 * `/mailbox/:id/keyvault`) - a bespoke class (own `@Init`-built `RepoUtils`, no `@Model`-driven CRUD, same
 * shape as `BaseEncryptionPolicyRoute`), because this is private key material, not an
 * ordinary collection.
 *
 * **Access is checked directly against the owning mailbox's `AccessControlList` and deliberately excludes the
 * usual trusted/admin bypass** (`ACLUtils.hasPermission()`'s built-in "trusted users always have permission"
 * short-circuit - confirmed by reading `ACLUtils.js` - is never called here): a system admin gets a `403`
 * unless they are literally the mailbox's `ownerUserUid` or hold an explicit delegate `ACLRecord` on it,
 * `getRecord()` (which has no such bypass) is used instead - and that delegate path only covers reads: every
 * write is owner-only (`requireMailboxOwner()`). Every mutating action here is audit-logged regardless of
 * caller, so any admin access that *does* occur through a genuine delegate grant is still visible after the
 * fact.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseKeyVaultRoute<K extends KeyVault, M extends Mailbox> {
    protected abstract keyVaultClass: any;
    protected abstract mailboxClass: any;
    protected abstract auditLogClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so `resolveAllowEscrow()` can confirm a wrap's claimed
     * `escrowScopeId` refers to a real `EscrowScope` without depending on either backend directly. */
    protected abstract escrowScopeClass: any;

    /** The `EncryptionPolicy` model, read for "Allow OpenPGP" (`OpenPgpPolicy`). Optional: without it, the config default applies. */
    protected encryptionPolicyClass?: any;

    /** Seeds "Allow OpenPGP" until an administrator saves a value (`OpenPgpPolicy`). */
    @Config(OPENPGP_ALLOWED_CONFIG, true)
    protected openPgpAllowedDefault: boolean = true;

    protected openPgpPolicy?: OpenPgpPolicy;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    protected keyVaultRepo?: RepoUtils<K>;
    protected mailboxRepo?: RepoUtils<M>;
    protected escrowScopeRepo?: RepoUtils<EscrowScope>;
    protected auditLogRepo?: RepoUtils<any>;
    protected auditLogUtils?: AuditLogUtils;

    @Inject(ACLUtils)
    private aclUtils?: ACLUtils;

    /** `trusted_roles`: a record for one of these on a mailbox's access list is administration, not membership. */
    @Config("trusted_roles", ["admin"])
    private trustedRoles: string[] = ["admin"];

    @Inject("EncryptionCertificateAuthority")
    private encryptionCa?: EncryptionCertificateAuthority;

    /** Same DI token `ManualSigningCertificateEnrollment`'s eventual admin-upload route and this class's
     * own `startSignEnrollment()`/`checkSignEnrollmentStatus()` consume - see `SigningCertificateEnrollment`'s
     * own doc comment on why the default (`NullSigningCertificateEnrollment`) makes both endpoints throw. */
    @Inject("SigningCertificateEnrollment")
    private signingCertificateEnrollment?: SigningCertificateEnrollment;

    /** Exposes the `@Model(...)`-supplied entity class so `@Transactional()` on `enrollKey()`/`rekey()` can
     * resolve which datasource to open a transaction against - identical reasoning to `BaseEscrowAccessRequestRoute`'s own
     * `modelClass` getter. */
    public get modelClass(): any {
        return (this.constructor as any).modelClass;
    }

    @Init
    protected async initialize(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        if (!this.openPgpPolicy) {
            const policyRepo: RepoUtils<EncryptionPolicy> | undefined = this.encryptionPolicyClass
                ? await this._objectFactory.newInstance(RepoUtils, { name: this.encryptionPolicyClass.name, args: [this.encryptionPolicyClass] })
                : undefined;
            this.openPgpPolicy = new OpenPgpPolicy(policyRepo, this.openPgpAllowedDefault);
        }
        if (!this.keyVaultRepo && this.keyVaultClass) {
            this.keyVaultRepo = await this._objectFactory.newInstance(RepoUtils, {
                name: this.keyVaultClass.name,
                args: [this.keyVaultClass],
            });
        }
        if (!this.mailboxRepo && this.mailboxClass) {
            this.mailboxRepo = await this._objectFactory.newInstance(RepoUtils, {
                name: this.mailboxClass.name,
                args: [this.mailboxClass],
            });
        }
        if (!this.escrowScopeRepo && this.escrowScopeClass) {
            this.escrowScopeRepo = await this._objectFactory.newInstance(RepoUtils, {
                name: this.escrowScopeClass.name,
                args: [this.escrowScopeClass],
            });
        }
        if (!this.auditLogRepo && this.auditLogClass) {
            this.auditLogRepo = await this._objectFactory.newInstance(RepoUtils, {
                name: this.auditLogClass.name,
                args: [this.auditLogClass],
            });
        }
        if (!this.auditLogUtils && this.auditLogClass) {
            this.auditLogUtils = await this._objectFactory.newInstance(AuditLogUtils, {
                name: this.auditLogClass.name,
                args: [this.auditLogRepo],
            });
        }
    }

    /**
     * Whether `wrap` (a caller-supplied `method: "escrow"` entry) may actually be persisted - only when the
     * mailbox is currently assigned to the exact `EscrowScope` the wrap claims (`Mailbox.escrowScopeId ===
     * wrap.escrowScopeId`, both required) and that scope still exists. This is the one place a mailbox
     * owner/delegate's own `enrollKey()`/`addMasterKeyWrap()` call can succeed in adding an escrow wrap -
     * client-side, they wrap their master key against `EscrowScope.publicKey` the same way they already wrap
     * it against a password/passkey; this method only confirms the server-side assignment actually permits
     * it, never inspects the wrap's ciphertext (opaque to this server either way).
     */
    private async resolveAllowEscrow(mailbox: M, wrap: MasterKeyWrap): Promise<boolean> {
        if (wrap.method !== "escrow") {
            return false;
        }
        if (!mailbox.escrowScopeId || wrap.escrowScopeId !== mailbox.escrowScopeId) {
            return false;
        }
        const scope: EscrowScope | undefined = await this.escrowScopeRepo!.findOne(mailbox.escrowScopeId, { ignoreACL: true });
        return !!scope;
    }

    /** The mailbox `mailboxId` names. A mailbox that doesn't exist is refused (403) exactly like one the caller has no access to
     * (`requireMailboxAccess()`), so the answer doesn't reveal which addresses have a key vault. */
    private async requireMailbox(mailboxId: string): Promise<M> {
        const mailbox: M | undefined = await this.mailboxRepo!.findOne(mailboxId, { ignoreACL: true });
        if (!mailbox) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
        return mailbox;
    }

    /** See this class's own doc comment on why `ACLUtils.hasPermission()` (with its unconditional trusted-role
     * bypass) is never used here. */
    private async requireMailboxAccess(mailbox: M, user: JWTUser | undefined, action: string): Promise<void> {
        if (user && mailbox.ownerUserUid === user.uid) {
            return;
        }
        const acl = await this.aclUtils!.findACL(mailbox.uid);
        const record = acl ? this.aclUtils!.getRecord(acl, user) : null;
        if (record && (record.actions.includes(action) || record.actions.includes(ACLAction.FULL))) {
            return;
        }
        throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
    }

    /** Stricter than `requireMailboxAccess()`: only the mailbox's actual `ownerUserUid` may proceed, not a
     * delegate holding an ordinary `UPDATE` grant (nor a trusted admin). Every key-vault WRITE requires it:
     * `rekey()`/`removeMasterKeyWrap()` can permanently destroy the owner's own access to their encrypted mail
     * history, and `enrollKey()`/`startSignEnrollment()`/`addMasterKeyWrap()` would let a delegate publish a key
     * of their own for the owner's address or add an unlock method they control to the owner's master key - an
     * `UPDATE` grant on a shared mailbox is meant for managing its content/settings, not its keys. `get()` is owner-only too
     * (`requireVaultReader()`); the sign-enrollment progress reads (`checkSignEnrollmentStatus()`) still accept a delegate `READ` grant. */
    private requireMailboxOwner(mailbox: M, user: JWTUser | undefined): void {
        if (!user || mailbox.ownerUserUid !== user.uid) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
    }

    /**
     * Who may read a mailbox's key vault - its wrapped private keys and master key wraps, which an offline guess at the owner's password
     * would open: only the mailbox's owner, like every write (`requireMailboxOwner()`); for a shared mailbox with no owner, a holder of
     * FULL. A delegate with only READ is no reader of it.
     */
    private async requireVaultReader(mailbox: M, user: JWTUser | undefined): Promise<void> {
        if (mailbox.ownerUserUid) {
            this.requireMailboxOwner(mailbox, user);
            return;
        }
        await this.requireMailboxAccess(mailbox, user, ACLAction.FULL);
    }

    /** Returned as an entity instance (`asEntity()`): every vault write below passes it as `existing` to
     * `RepoUtils.update()`, whose optimistic lock only applies to one - MongoDB's `find()` returns plain documents, so
     * two concurrent writes (e.g. `enrollKey()` and `rekey()`) could otherwise both succeed, the later one silently
     * dropping the other's wrapped private key. A lost race is now a `409`. */
    private async findKeyVault(mailboxUid: string): Promise<K | undefined> {
        const existing: K[] = await this.keyVaultRepo!.find({ mailboxUid, limit: 1 } as any, { ignoreACL: true, limit: 1, skipCache: true });
        return existing[0] ? asEntity(this.keyVaultRepo!, existing[0]) : undefined;
    }

    /** Same TOCTOU-tolerant create-or-fetch as `BaseEncryptionPolicyRoute.findOrCreate()`, keyed by
     * `mailboxUid` instead of a fixed global uid - two concurrent first-ever enrollments for the same mailbox
     * can both observe no existing row and both reach `create()`; the loser's `create()` throws a raw
     * driver duplicate-key error (enforced by `KeyVaultSQL`/`KeyVaultMongo`'s own unique index on
     * `mailboxUid`), and re-fetching the now-existing row is the correct outcome. */
    private async findOrCreateKeyVault(mailboxUid: string): Promise<K> {
        const existing: K | undefined = await this.findKeyVault(mailboxUid);
        if (existing) {
            return existing;
        }
        try {
            return await this.keyVaultRepo!.create(new this.keyVaultClass({ mailboxUid }), { ignoreACL: true });
        } catch (err) {
            const winner: K | undefined = await this.findKeyVault(mailboxUid);
            if (winner) {
                return winner;
            }
            throw err;
        }
    }

    @Get("/:id/keyvault")
    public async get(@Param("id") mailboxId: string, @AuthUser user?: JWTUser): Promise<PublicKeyVault> {
        const mailbox: M = await this.requireMailbox(mailboxId);
        await this.requireVaultReader(mailbox, user);

        const existing: K | undefined = await this.findKeyVault(mailboxId);
        // Audit-logged like every mutating endpoint below, not just those - this is the one operation that
        // actually exfiltrates the vault's contents (including, via `masterKeyWraps`, an escrow wrap capable
        // of decrypting the mailbox). `specs/end-to-end_encryption.md`'s escrow audit requirement ("every
        // escrow use MUST be recorded ... capturing the holder ... and the time") depends on this read being
        // visible after the fact, same as this class's own doc comment already promises for every mutation.
        await this.auditLogUtils!.record(
            { action: AuditAction.KEY_VAULT_READ, targetType: "KeyVault", targetUid: existing?.uid ?? mailbox.uid, mailboxUid: mailbox.uid },
            { user },
        );
        return existing ? toPublicKeyVault(existing, mailbox) : { ...EMPTY_KEY_VAULT, zeroAccessKeys: mailbox.zeroAccessKeys ?? [] };
    }

    /**
     * Enrolls a new signing or encryption key for `mailboxId`. For `useType: "encrypt"`, this endpoint itself
     * calls the injected `EncryptionCertificateAuthority.issue()` against the caller-supplied CSR - the server
     * never trusts a client-submitted encryption certificate wholesale, since the whole point of an internal
     * CA is that it alone decides what gets a trusted-by-this-deployment certificate. For `useType: "sign"`,
     * the certificate was already issued by a public CA via the separate, asynchronous
     * `SigningCertificateEnrollment` flow - this endpoint validates it (parseable, matches the mailbox
     * identity is left to the CA that issued it) and installs it, since re-litigating a public CA's own
     * issuance decision is not this server's job.
     *
     * The new key becomes the mailbox's active key of its `useType`: every older unrevoked key of that `useType` gets
     * `revokedAt` (the install time) in the same mailbox update (`supersedeKeys()`), so discovery shows it as retired.
     * Its wrapped private key stays in the vault.
     *
     * Atomic: the new `PublicKey` (appended to `Mailbox.keys`) and the `WrappedPrivateKey`/initial
     * `MasterKeyWrap`s (appended to `KeyVault`) are written in one transaction, so a failure partway through
     * can never leave a published public key with no corresponding vault entry, or vice versa.
     */
    @Post("/:id/keyvault/keys")
    public async enrollKey(
        @Param("id") mailboxId: string,
        body: EnrollKeyRequest,
        @AuthUser user?: JWTUser,
    ): Promise<PublicKeyVault> {
        const mailbox: M = await this.requireMailbox(mailboxId);
        this.requireMailboxOwner(mailbox, user);

        if (!body?.wrappedKey) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "wrappedKey is required.");
        }
        validateWrappedPrivateKey(body.wrappedKey);
        const expectedGeneration: number | undefined = readExpectedGeneration(body);
        const requestedMasterKeyWraps: MasterKeyWrap[] = body.masterKeyWraps ?? [];
        if (requestedMasterKeyWraps.length > MAX_MASTER_KEY_WRAPS) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `masterKeyWraps cannot exceed ${MAX_MASTER_KEY_WRAPS} entries.`);
        }
        for (const wrap of requestedMasterKeyWraps) {
            validateMasterKeyWrap(wrap, { allowEscrow: await this.resolveAllowEscrow(mailbox, wrap) });
        }
        if ((mailbox.keys ?? []).length + (mailbox.zeroAccessKeys ?? []).length >= MAX_ENROLLED_KEYS) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `A mailbox cannot enroll more than ${MAX_ENROLLED_KEYS} keys.`);
        }

        let publicKey: PublicKey | ZeroAccessKey;
        let fingerprint: string;
        if (body.type !== undefined && body.type !== "x509" && body.type !== OPENPGP_KEY_TYPE) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "type must be 'x509' or 'openpgp'.");
        }
        if (body.type === OPENPGP_KEY_TYPE) {
            // Self-certified by the client: checked, never issued. It must be usable now and name the mailbox's own address.
            if (body.useType !== "encrypt") {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "An OpenPGP key is enrolled with useType 'encrypt'.");
            }
            if (!(await this.openPgpPolicy!.allowed())) {
                throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, "OpenPGP keys are disabled on this server.");
            }
            publicKey = await parseOpenPgpContactKey(body.publicKey, mailbox.primarySmtpAddress);
            fingerprint = publicKey.fingerprint;
        } else if (body.useType === "encrypt") {
            if (!body.csr) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "csr is required for useType 'encrypt'.");
            }
            const issued = await this.encryptionCa!.issue(mailbox.primarySmtpAddress, body.csr);
            const cert = new crypto.X509Certificate(issued.certificate);
            fingerprint = issued.fingerprint;
            const encryptKey: PublicKey = {
                publicKey: cert.raw.toString("base64"),
                type: "x509",
                useType: "encrypt",
                fingerprint,
                notBefore: issued.notBefore.getTime(),
                notAfter: issued.notAfter.getTime(),
            };
            // Published only when it provably issued the certificate (dropped otherwise, never refused).
            const issuerCertificate: string | undefined = verifiedIssuerCertificate(cert, issued.issuerCertificate);
            if (issuerCertificate) {
                encryptKey.issuerCertificate = issuerCertificate;
            }
            publicKey = encryptKey;
        } else if (body.useType === "zero-access") {
            // Issued by the internal CA like an encryption key (CMS addresses its recipient by certificate), but never
            // published: it lands on `Mailbox.zeroAccessKeys`, which nothing serves outside this mailbox's own reads.
            if (!body.csr) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "csr is required for useType 'zero-access'.");
            }
            const issued = await this.encryptionCa!.issue(mailbox.primarySmtpAddress, body.csr);
            const cert = new crypto.X509Certificate(issued.certificate);
            fingerprint = issued.fingerprint;
            publicKey = {
                publicKey: cert.raw.toString("base64"),
                type: "x509",
                useType: "zero-access",
                fingerprint,
                notBefore: issued.notBefore.getTime(),
                notAfter: issued.notAfter.getTime(),
            };
        } else if (body.useType === "sign") {
            if (!body.certificate) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "certificate is required for useType 'sign'.");
            }
            // A PEM chain installs its first certificate and publishes the second as `issuerCertificate` when it verifies.
            const result = publicKeyFromCertificatePem(body.certificate, "sign", mailbox.primarySmtpAddress);
            publicKey = result.publicKey;
            fingerprint = result.fingerprint;
        } else {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "useType must be 'sign', 'encrypt' or 'zero-access'.");
        }

        const collision: PublicKey | ZeroAccessKey | undefined = [...(mailbox.keys ?? []), ...(mailbox.zeroAccessKeys ?? [])].find(
            (k) => k.fingerprint === fingerprint,
        );
        if (collision && !collision.revokedAt && collision.notAfter > Date.now()) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "A non-expired, non-revoked key with this fingerprint is already enrolled.");
        }

        const wrappedKey: WrappedPrivateKey = pickWrappedKey({ ...body.wrappedKey, fingerprint, useType: body.useType, type: publicKey.type });

        // Checked here too (not only in `persistEnrollment()`), so a doomed request doesn't reach the writes.
        const currentVault: K | undefined = await this.findKeyVault(mailbox.uid);
        assertMasterKeyWrapsAccepted(currentVault, body.masterKeyWraps);
        assertMasterKeyGeneration(currentVault, expectedGeneration);

        const persisted = await this.persistEnrollment(mailbox, publicKey, wrappedKey, body.masterKeyWraps, expectedGeneration);

        await this.auditLogUtils!.record(
            {
                action: AuditAction.KEY_VAULT_ENROLL,
                targetType: "KeyVault",
                targetUid: persisted.keyVault.uid,
                mailboxUid: mailbox.uid,
                details: { useType: body.useType, fingerprint, ...(isOpenPgpKey(publicKey) ? { type: OPENPGP_KEY_TYPE } : {}) },
            },
            { user },
        );

        return toPublicKeyVault(persisted.keyVault, persisted.mailbox);
    }

    /** `expectedGeneration`, when given, must still be the vault's master key generation (409 otherwise) - see
     * `ExpectedMasterKeyGeneration`. */
    @Transactional()
    protected async persistEnrollment(
        mailbox: M,
        publicKey: PublicKey | ZeroAccessKey,
        wrappedKey: WrappedPrivateKey,
        initialMasterKeyWraps: MasterKeyWrap[] | undefined,
        expectedGeneration?: number,
    ): Promise<{ mailbox: M; keyVault: K }> {
        // The vault is read (and the bootstrap wraps and generation checked against it) before anything is written; the
        // vault update below is version-checked, so a concurrent enrollment or rekey that lands in between is a 409 too.
        const keyVault: K = await this.findOrCreateKeyVault(mailbox.uid);
        assertMasterKeyWrapsAccepted(keyVault, initialMasterKeyWraps);
        assertMasterKeyGeneration(keyVault, expectedGeneration);

        // A zero-access key supersedes only the mailbox's earlier zero-access keys, on their own (never published) list. The first one
        // activates zero-access for the mailbox, which decides what it covers from the owner's devices (`specs/search.md` §3).
        const settled = publicKey.useType === "zero-access" && !mailbox.zeroAccessKeys?.length ? settleZeroAccessTypes(mailbox, true) : undefined;
        const keyField: Partial<Mailbox> =
            publicKey.useType === "zero-access"
                ? { zeroAccessKeys: supersedeKeys(mailbox.zeroAccessKeys, publicKey, Date.now()), ...(settled ? { zeroAccessTypes: settled } : {}) }
                : { keys: supersedeKeys(mailbox.keys, publicKey, Date.now()) };
        const updatedMailbox: M = await this.mailboxRepo!.update(
            { uid: mailbox.uid, version: (mailbox as any).version, ...keyField } as any,
            mailbox,
            { ignoreACL: true },
        );

        // `initialMasterKeyWraps` only ever reaches an empty vault (`assertMasterKeyWrapsAccepted()`).
        const masterKeyWraps: MasterKeyWrap[] = initialMasterKeyWraps?.length ? initialMasterKeyWraps.map(pickMasterKeyWrap) : keyVault.masterKeyWraps;
        const updatedKeyVault: K = await this.keyVaultRepo!.update(
            {
                uid: keyVault.uid,
                version: (keyVault as any).version,
                wrappedKeys: [...keyVault.wrappedKeys, wrappedKey],
                masterKeyWraps,
            } as any,
            keyVault,
            { ignoreACL: true },
        );

        return { mailbox: updatedMailbox, keyVault: updatedKeyVault };
    }

    /**
     * `GET /mailbox/:id/keyvault/members` - where a shared mailbox's zero-access key stands with its members (`specs/search.md` §3 *Shared
     * Mailboxes*): who the members are, each one's own zero-access certificate (on a mailbox they own, `undefined` until they first sign in
     * and get one) and which of the mailbox's zero-access keys they hold a wrap of; who is still waiting for a wrap of the active key; who
     * holds wraps but is no longer a member; and whether the key must be rotated because of them. A client that holds the key fulfils
     * the pending grants and runs the rotation (`putMemberKeyWraps()`, `enrollSharedZeroAccessKey()`, `removeMemberKeyWraps()`).
     *
     * For the owner and every member (read or full access); `manager` says whether the caller may change the wraps.
     */
    @Get("/:id/keyvault/members")
    public async memberKeyStatus(@Param("id") mailboxId: string, @AuthUser user?: JWTUser): Promise<SharedKeyStatus> {
        const mailbox: M = await this.requireMailbox(mailboxId);
        await this.requireMailboxAccess(mailbox, user, ACLAction.READ);
        return await this.sharedKeyStatus(mailbox, user);
    }

    /** `GET /mailbox/:id/keyvault/member-wraps` - the caller's own wraps of this mailbox's zero-access keys (`[]` for the owner, who opens
     * them with the master key, and for a member still waiting). Only for a current member: a removed member reads nothing more. */
    @Get("/:id/keyvault/member-wraps")
    public async myMemberKeyWraps(@Param("id") mailboxId: string, @AuthUser user?: JWTUser): Promise<MemberKeyWrap[]> {
        const mailbox: M = await this.requireMailbox(mailboxId);
        await this.requireMailboxAccess(mailbox, user, ACLAction.READ);
        const me: string | undefined = canonicalUserUid(user!.uid);
        if (!(await this.members(mailbox)).some((member) => member.userUid === me)) {
            return [];
        }
        const keyVault: K | undefined = await this.findKeyVault(mailbox.uid);
        return (keyVault?.memberKeyWraps ?? []).filter((wrap) => wrap.memberUserUid === me);
    }

    /**
     * `PUT /mailbox/:id/keyvault/member-wraps` - adds (or replaces, per member and key) wraps of this mailbox's zero-access keys for its
     * members: how an unlocked client holding the key fulfils pending grants. For the owner and members with full access. Each wrap must
     * name a current member, the member's own zero-access certificate (by fingerprint) and one of this mailbox's zero-access keys, and must
     * be CMS addressed to that certificate (`isSealedToCertificate()`) - the server can't read what is inside.
     */
    @Put("/:id/keyvault/member-wraps")
    public async putMemberKeyWraps(@Param("id") mailboxId: string, body: { wraps?: MemberKeyWrapInput[] }, @AuthUser user?: JWTUser): Promise<SharedKeyStatus> {
        const mailbox: M = await this.requireMailbox(mailboxId);
        await this.requireMailboxManager(mailbox, user);
        const wraps: MemberKeyWrapInput[] = Array.isArray(body?.wraps) ? body.wraps : [];
        if (wraps.length === 0 || wraps.length > MAX_MEMBER_KEY_WRAPS) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `wraps must list between 1 and ${MAX_MEMBER_KEY_WRAPS} wraps.`);
        }
        const accepted: MemberKeyWrap[] = await this.validateMemberWraps(mailbox, wraps, false);
        const keyVault: K = await this.findOrCreateKeyVault(mailbox.uid);
        const replaced = (existing: MemberKeyWrap) =>
            accepted.some((wrap) => wrap.memberUserUid === existing.memberUserUid && wrap.zeroAccessKeyFingerprint === existing.zeroAccessKeyFingerprint);
        const memberKeyWraps: MemberKeyWrap[] = [...(keyVault.memberKeyWraps ?? []).filter((existing) => !replaced(existing)), ...accepted];
        if (memberKeyWraps.length > MAX_MEMBER_KEY_WRAPS) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `A mailbox cannot hold more than ${MAX_MEMBER_KEY_WRAPS} member key wraps.`);
        }
        await this.keyVaultRepo!.update({ uid: keyVault.uid, version: (keyVault as any).version, memberKeyWraps } as any, keyVault, { ignoreACL: true });
        await this.auditLogUtils!.record(
            {
                action: AuditAction.KEY_VAULT_MEMBER_WRAPS,
                targetType: "KeyVault",
                targetUid: keyVault.uid,
                mailboxUid: mailbox.uid,
                details: { added: accepted.map(({ memberUserUid, zeroAccessKeyFingerprint }) => ({ memberUserUid, zeroAccessKeyFingerprint })) },
            },
            { user },
        );
        return await this.sharedKeyStatus(await this.requireMailbox(mailbox.uid), user);
    }

    /** `DELETE /mailbox/:id/keyvault/member-wraps/:memberUserUid` - removes every wrap of someone who is no longer a member (`409` for a
     * current member: their access is removed on the access list, and the key rotated, not by taking their wraps). For the owner and
     * members with full access - the last step of a rotation (`enrollSharedZeroAccessKey()`). */
    @Delete("/:id/keyvault/member-wraps/:memberUserUid")
    public async removeMemberKeyWraps(
        @Param("id") mailboxId: string,
        @Param("memberUserUid") memberUserUid: string,
        @AuthUser user?: JWTUser,
    ): Promise<SharedKeyStatus> {
        const mailbox: M = await this.requireMailbox(mailboxId);
        await this.requireMailboxManager(mailbox, user);
        const departed: string = canonicalUserUid(memberUserUid) ?? "";
        if ((await this.members(mailbox)).some((member) => member.userUid === departed)) {
            throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, "This user is still a member of the mailbox.");
        }
        const keyVault: K | undefined = await this.findKeyVault(mailbox.uid);
        const remaining: MemberKeyWrap[] = (keyVault?.memberKeyWraps ?? []).filter((wrap) => wrap.memberUserUid !== departed);
        if (keyVault && remaining.length !== (keyVault.memberKeyWraps ?? []).length) {
            await this.keyVaultRepo!.update({ uid: keyVault.uid, version: (keyVault as any).version, memberKeyWraps: remaining } as any, keyVault, {
                ignoreACL: true,
            });
            await this.auditLogUtils!.record(
                { action: AuditAction.KEY_VAULT_MEMBER_WRAPS, targetType: "KeyVault", targetUid: keyVault.uid, mailboxUid: mailbox.uid, details: { removed: departed } },
                { user },
            );
        }
        return await this.sharedKeyStatus(mailbox, user);
    }

    /**
     * `POST /mailbox/:id/keyvault/shared-zero-access-key` - provisions (or, on a rotation, replaces) the zero-access key of a mailbox with
     * no owner, which has no master key to seal it under: the certificate is issued for `csr` and becomes the mailbox's active zero-access
     * key in the same write as `wraps`, the member wraps of its private key - at least the caller's own. Mail is therefore never sealed to a
     * key nobody holds. For members with full access; an owned mailbox's owner enrolls through `enrollKey()` and adds wraps with
     * `putMemberKeyWraps()`.
     *
     * A mailbox assigned to an escrow scope also needs `escrowWrap`, the private key wrapped to the scope's certificate, written in the
     * same transaction: with no master key, it is the only way escrow can ever read the mailbox's mail.
     */
    @Post("/:id/keyvault/shared-zero-access-key")
    public async enrollSharedZeroAccessKey(
        @Param("id") mailboxId: string,
        body: { csr?: string; wraps?: Omit<MemberKeyWrapInput, "zeroAccessKeyFingerprint">[]; escrowWrap?: Omit<ZeroAccessEscrowWrapInput, "zeroAccessKeyFingerprint"> },
        @AuthUser user?: JWTUser,
    ): Promise<SharedKeyStatus> {
        const mailbox: M = await this.requireMailbox(mailboxId);
        if (mailbox.ownerUserUid) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "A mailbox with an owner gets its zero-access key from its owner.");
        }
        await this.requireMailboxManager(mailbox, user);
        const wraps = Array.isArray(body?.wraps) ? body.wraps : [];
        if (!body?.csr || wraps.length === 0 || wraps.length > MAX_MEMBER_KEY_WRAPS) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `csr and between 1 and ${MAX_MEMBER_KEY_WRAPS} wraps are required.`);
        }
        const me: string = canonicalUserUid(user!.uid) ?? "";
        if (!wraps.some((wrap) => wrap?.memberUserUid === me)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "wraps must include your own.");
        }
        if ((mailbox.zeroAccessKeys ?? []).length >= MAX_ENROLLED_KEYS) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `A mailbox cannot enroll more than ${MAX_ENROLLED_KEYS} keys.`);
        }
        const scope: EscrowScope | undefined = await this.assignedEscrowScope(mailbox);
        if (scope && !body.escrowWrap) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "This mailbox is assigned to an escrow scope: escrowWrap is required.");
        }
        const issued = await this.encryptionCa!.issue(mailbox.primarySmtpAddress, body.csr);
        const cert = new crypto.X509Certificate(issued.certificate);
        const publicKey: ZeroAccessKey = {
            publicKey: cert.raw.toString("base64"),
            type: "x509",
            useType: "zero-access",
            fingerprint: issued.fingerprint,
            notBefore: issued.notBefore.getTime(),
            notAfter: issued.notAfter.getTime(),
        };
        const accepted: MemberKeyWrap[] = await this.validateMemberWraps(
            mailbox,
            wraps.map((wrap) => ({ ...wrap, zeroAccessKeyFingerprint: publicKey.fingerprint })),
            true,
        );
        const escrowWraps: ZeroAccessEscrowWrap[] = scope
            ? this.validateEscrowWraps(mailbox, scope, [{ ...body.escrowWrap!, zeroAccessKeyFingerprint: publicKey.fingerprint }], publicKey.fingerprint)
            : [];
        const keyVault: K = await this.persistSharedEnrollment(mailbox, publicKey, accepted, escrowWraps);
        await this.auditLogUtils!.record(
            {
                action: AuditAction.KEY_VAULT_ENROLL,
                targetType: "KeyVault",
                targetUid: keyVault.uid,
                mailboxUid: mailbox.uid,
                details: {
                    useType: "zero-access",
                    fingerprint: publicKey.fingerprint,
                    shared: true,
                    members: accepted.map((wrap) => wrap.memberUserUid),
                    ...(scope ? { escrowScopeId: scope.uid } : {}),
                },
            },
            { user },
        );
        return await this.sharedKeyStatus(await this.requireMailbox(mailbox.uid), user);
    }

    /** The new key on the mailbox and its member and escrow wraps in the vault, in one transaction. */
    @Transactional()
    protected async persistSharedEnrollment(mailbox: M, publicKey: ZeroAccessKey, wraps: MemberKeyWrap[], escrowWraps: ZeroAccessEscrowWrap[]): Promise<K> {
        const keyVault: K = await this.findOrCreateKeyVault(mailbox.uid);
        await this.mailboxRepo!.update(
            { uid: mailbox.uid, version: (mailbox as any).version, zeroAccessKeys: supersedeKeys(mailbox.zeroAccessKeys, publicKey, Date.now()) } as any,
            mailbox,
            { ignoreACL: true },
        );
        return await this.keyVaultRepo!.update(
            {
                uid: keyVault.uid,
                version: (keyVault as any).version,
                memberKeyWraps: [...(keyVault.memberKeyWraps ?? []), ...wraps],
                ...(escrowWraps.length ? { zeroAccessEscrowWraps: [...(keyVault.zeroAccessEscrowWraps ?? []), ...escrowWraps] } : {}),
            } as any,
            keyVault,
            { ignoreACL: true },
        );
    }

    /**
     * `PUT /mailbox/:id/keyvault/escrow-wraps` - adds (or replaces, per scope and key) escrow copies of a mailbox-without-an-owner's
     * zero-access keys: how a key provisioned before the mailbox was assigned to its escrow scope (or under an earlier scope) is brought
     * under the current one. For members with full access. Each wrap must name the mailbox's current escrow scope and one of its
     * zero-access keys, and be CMS addressed to the scope's certificate (`isSealedToCertificate()`). A mailbox with an owner is refused
     * (`400`): its escrowed master key already opens its keys.
     */
    @Put("/:id/keyvault/escrow-wraps")
    public async putZeroAccessEscrowWraps(
        @Param("id") mailboxId: string,
        body: { wraps?: ZeroAccessEscrowWrapInput[] },
        @AuthUser user?: JWTUser,
    ): Promise<SharedKeyStatus> {
        const mailbox: M = await this.requireMailbox(mailboxId);
        if (mailbox.ownerUserUid) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "A mailbox with an owner is escrowed through its master key.");
        }
        await this.requireMailboxManager(mailbox, user);
        const scope: EscrowScope | undefined = await this.assignedEscrowScope(mailbox);
        if (!scope) {
            throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, "This mailbox is not assigned to an escrow scope.");
        }
        const wraps: ZeroAccessEscrowWrapInput[] = Array.isArray(body?.wraps) ? body.wraps : [];
        if (wraps.length === 0 || wraps.length > MAX_ENROLLED_KEYS) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `wraps must list between 1 and ${MAX_ENROLLED_KEYS} wraps.`);
        }
        const accepted: ZeroAccessEscrowWrap[] = this.validateEscrowWraps(mailbox, scope, wraps);
        const keyVault: K = await this.findOrCreateKeyVault(mailbox.uid);
        const replaced = (existing: ZeroAccessEscrowWrap) =>
            accepted.some((wrap) => wrap.escrowScopeId === existing.escrowScopeId && wrap.zeroAccessKeyFingerprint === existing.zeroAccessKeyFingerprint);
        const zeroAccessEscrowWraps: ZeroAccessEscrowWrap[] = [...(keyVault.zeroAccessEscrowWraps ?? []).filter((existing) => !replaced(existing)), ...accepted];
        if (zeroAccessEscrowWraps.length > MAX_ESCROW_ZERO_ACCESS_WRAPS) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `A mailbox cannot hold more than ${MAX_ESCROW_ZERO_ACCESS_WRAPS} escrow key wraps.`);
        }
        await this.keyVaultRepo!.update({ uid: keyVault.uid, version: (keyVault as any).version, zeroAccessEscrowWraps } as any, keyVault, {
            ignoreACL: true,
        });
        await this.auditLogUtils!.record(
            {
                action: AuditAction.KEY_VAULT_ESCROW_WRAPS,
                targetType: "KeyVault",
                targetUid: keyVault.uid,
                mailboxUid: mailbox.uid,
                details: { escrowScopeId: scope.uid, zeroAccessKeyFingerprints: accepted.map((wrap) => wrap.zeroAccessKeyFingerprint) },
            },
            { user },
        );
        return await this.sharedKeyStatus(mailbox, user);
    }

    /** The escrow scope a mailbox is assigned to, when it still exists. */
    private async assignedEscrowScope(mailbox: M): Promise<EscrowScope | undefined> {
        return mailbox.escrowScopeId ? await this.escrowScopeRepo!.findOne(mailbox.escrowScopeId, { ignoreACL: true }) : undefined;
    }

    /** `wraps` checked and completed, or a `400` naming what is wrong. `newKey` is the fingerprint of a key being enrolled with them, not
     * yet on the mailbox. */
    private validateEscrowWraps(mailbox: M, scope: EscrowScope, wraps: ZeroAccessEscrowWrapInput[], newKey?: string): ZeroAccessEscrowWrap[] {
        const zeroAccessFingerprints: Set<string> = new Set([...(mailbox.zeroAccessKeys ?? []).map((key) => key.fingerprint), ...(newKey ? [newKey] : [])]);
        const certificate: Buffer = Buffer.from(scope.publicKey.publicKey, "base64");
        const seen: Set<string> = new Set();
        return wraps.map((wrap) => {
            if (
                wrap?.escrowScopeId !== scope.uid ||
                typeof wrap.zeroAccessKeyFingerprint !== "string" ||
                !zeroAccessFingerprints.has(wrap.zeroAccessKeyFingerprint) ||
                typeof wrap.cms !== "string" ||
                wrap.cms.length > MAX_WRAP_FIELD_LENGTH * 4
            ) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "Each escrow wrap must name the mailbox's escrow scope and one of its zero-access keys.");
            }
            if (seen.has(wrap.zeroAccessKeyFingerprint)) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "A key can have only one escrow wrap.");
            }
            seen.add(wrap.zeroAccessKeyFingerprint);
            if (!isSealedToCertificate(Buffer.from(wrap.cms, "base64"), certificate)) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "Each escrow wrap must be encrypted to the escrow scope's certificate.");
            }
            return {
                escrowScopeId: scope.uid,
                escrowKeyFingerprint: scope.publicKey.fingerprint,
                zeroAccessKeyFingerprint: wrap.zeroAccessKeyFingerprint,
                cms: wrap.cms,
                createdAt: Date.now(),
            };
        });
    }

    /** The mailbox's members (`ZeroAccessResolver.members()`), from its access list as stored now: who may hold the key is never decided
     * from a cached list, so a removed member stops getting wraps the moment they are removed. */
    private async members(mailbox: M): Promise<{ userUid: string; full: boolean }[]> {
        return zeroAccessMembers(await this.aclUtils!.findACL(mailbox.uid, undefined, { skipCache: true }), mailbox, this.trustedRoles);
    }

    /** Who may change a shared mailbox's member wraps: its owner, and members with full access (`403` for anyone else). */
    private async requireMailboxManager(mailbox: M, user: JWTUser | undefined): Promise<void> {
        if (user && mailbox.ownerUserUid && mailbox.ownerUserUid === user.uid) {
            return;
        }
        const me: string | undefined = user ? (canonicalUserUid(user.uid)) : undefined;
        if (!me || !(await this.members(mailbox)).some((member) => member.userUid === me && member.full)) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
    }

    /** A user's own zero-access certificate: the active zero-access key of a mailbox they own (the first by uid, when they own several). */
    private async memberCertificate(userUid: string): Promise<ZeroAccessKey | undefined> {
        const owned: M[] = await this.mailboxRepo!.find({ ownerUserUid: userUid, sort: { uid: "ASC" }, limit: 50 } as any, { ignoreACL: true, limit: 50 });
        for (const mailbox of owned) {
            const key: ZeroAccessKey | undefined = activeZeroAccessKey(mailbox);
            if (key) {
                return key;
            }
        }
        return undefined;
    }

    /** `wraps` checked and completed (`createdAt`), or a `400` naming what is wrong. `newKey` skips the check that the wrapped key is
     * already one of the mailbox's (it is being enrolled with them). */
    private async validateMemberWraps(mailbox: M, wraps: MemberKeyWrapInput[], newKey: boolean): Promise<MemberKeyWrap[]> {
        const members: Set<string> = new Set((await this.members(mailbox)).map((member) => member.userUid));
        const zeroAccessFingerprints: Set<string> = new Set((mailbox.zeroAccessKeys ?? []).map((key) => key.fingerprint));
        const certificates: Map<string, ZeroAccessKey | undefined> = new Map();
        const accepted: MemberKeyWrap[] = [];
        const seen: Set<string> = new Set();
        for (const wrap of wraps) {
            const memberUserUid: string | undefined = typeof wrap?.memberUserUid === "string" ? (canonicalUserUid(wrap.memberUserUid)) : undefined;
            if (
                !memberUserUid ||
                !members.has(memberUserUid) ||
                typeof wrap.recipientFingerprint !== "string" ||
                typeof wrap.zeroAccessKeyFingerprint !== "string" ||
                typeof wrap.cms !== "string" ||
                wrap.cms.length > MAX_WRAP_FIELD_LENGTH * 4 ||
                (!newKey && !zeroAccessFingerprints.has(wrap.zeroAccessKeyFingerprint))
            ) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "Each wrap must name a member and one of this mailbox's zero-access keys.");
            }
            const key = `${memberUserUid}:${wrap.zeroAccessKeyFingerprint}`;
            if (seen.has(key)) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "A member can have only one wrap of each key.");
            }
            seen.add(key);
            if (!certificates.has(memberUserUid)) {
                certificates.set(memberUserUid, await this.memberCertificate(memberUserUid));
            }
            const certificate: ZeroAccessKey | undefined = certificates.get(memberUserUid);
            if (!certificate || certificate.fingerprint !== wrap.recipientFingerprint || !isSealedToCertificate(Buffer.from(wrap.cms, "base64"), Buffer.from(certificate.publicKey, "base64"))) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "Each wrap must be encrypted to its member's own zero-access certificate.");
            }
            accepted.push({
                memberUserUid,
                recipientFingerprint: wrap.recipientFingerprint,
                zeroAccessKeyFingerprint: wrap.zeroAccessKeyFingerprint,
                cms: wrap.cms,
                createdAt: Date.now(),
            });
        }
        return accepted;
    }

    private async sharedKeyStatus(mailbox: M, user: JWTUser | undefined): Promise<SharedKeyStatus> {
        const members = await this.members(mailbox);
        const memberUids: Set<string> = new Set(members.map((member) => member.userUid));
        const keyVault: K | undefined = await this.findKeyVault(mailbox.uid);
        const wraps: MemberKeyWrap[] = keyVault?.memberKeyWraps ?? [];
        const active: ZeroAccessKey | undefined = activeZeroAccessKey(mailbox);
        const memberStatus: SharedKeyMember[] = [];
        for (const member of members) {
            const certificate: ZeroAccessKey | undefined = await this.memberCertificate(member.userUid);
            memberStatus.push({
                userUid: member.userUid,
                full: member.full,
                ...(certificate ? { certificate } : {}),
                wrapped: wraps.filter((wrap) => wrap.memberUserUid === member.userUid).map((wrap) => wrap.zeroAccessKeyFingerprint),
            });
        }
        const departed: string[] = [...new Set(wraps.map((wrap) => wrap.memberUserUid).filter((uid) => !memberUids.has(uid)))];
        const me: string | undefined = user ? canonicalUserUid(user.uid) : undefined;
        const owner: boolean = !!user && !!mailbox.ownerUserUid && mailbox.ownerUserUid === user.uid;
        const scope: EscrowScope | undefined = mailbox.ownerUserUid ? undefined : await this.assignedEscrowScope(mailbox);
        const escrowed: Set<string> = new Set(
            (keyVault?.zeroAccessEscrowWraps ?? []).filter((wrap) => wrap.escrowScopeId === scope?.uid).map((wrap) => wrap.zeroAccessKeyFingerprint),
        );
        return {
            ownerless: !mailbox.ownerUserUid,
            role: owner ? "owner" : memberUids.has(me ?? "") ? "member" : "other",
            ...(active ? { activeKeyFingerprint: active.fingerprint } : {}),
            zeroAccessKeys: mailbox.zeroAccessKeys ?? [],
            members: memberStatus,
            pending: active
                ? memberStatus.filter((member) => member.certificate && !member.wrapped.includes(active.fingerprint)).map((member) => member.userUid)
                : [],
            departed,
            rotationPending: !!active && wraps.some((wrap) => !memberUids.has(wrap.memberUserUid) && wrap.zeroAccessKeyFingerprint === active.fingerprint),
            manager: (!!user && mailbox.ownerUserUid === user.uid) || members.some((member) => member.userUid === me && member.full),
            ...(scope ? { escrowScopeId: scope.uid } : {}),
            escrowPending: scope ? (mailbox.zeroAccessKeys ?? []).map((key) => key.fingerprint).filter((fingerprint) => !escrowed.has(fingerprint)) : [],
        };
    }

    /**
     * Starts automated public signing-certificate enrollment against whichever `SigningCertificateEnrollment`
     * is registered (`Rfc8823AcmeSigningCertificateEnrollment` in production; the default
     * `NullSigningCertificateEnrollment` simply throws "not available", matching every other optional
     * pluggable interface in this codebase). `csr` is the only thing `startEnrollment()`'s own shared
     * interface needs; `wrappedKey` is submitted here too (not part of that interface) so a real
     * implementation that supports it (feature-detected via `attachWrappedKey`) can hold onto it and, once
     * the CA actually issues the certificate, auto-install the finished key pair into this mailbox's
     * `KeyVault` with no further client action - `getIssuedMaterial()`'s own doc comment (on the RFC 8823
     * implementation) has the full reasoning. An implementation without that method (the manual-CA
     * default, or `Null`) simply never receives the wrapped key here - its own existing `enrollKey()` call
     * (once an admin has the certificate in hand) is unaffected either way.
     *
     * Deliberately not itself `@Transactional()`/audit-logged: unlike `enrollKey()`, nothing is installed
     * into this mailbox's own data yet - only a pending enrollment starts existing in a separate store.
     * The eventual install (this feature's own driver job, once the CA issues the certificate) reuses
     * `persistEnrollment()` above and is audited exactly like `enrollKey()`'s own manual path.
     */
    @Post("/:id/keyvault/keys/sign-enrollment")
    public async startSignEnrollment(
        @Param("id") mailboxId: string,
        body: SignEnrollmentRequest,
        @AuthUser user?: JWTUser,
    ): Promise<{ enrollmentId: string }> {
        const mailbox: M = await this.requireMailbox(mailboxId);
        this.requireMailboxOwner(mailbox, user);

        if (!body?.csr) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "csr is required.");
        }
        validateWrappedPrivateKey(body.wrappedKey);
        const expectedGeneration: number | undefined = readExpectedGeneration(body);
        // Checked before the CA is contacted: a key sealed under a master key another device has since rotated away
        // would only ever be refused at install time.
        const keyVault: K | undefined = await this.findKeyVault(mailbox.uid);
        assertMasterKeyGeneration(keyVault, expectedGeneration);

        const { enrollmentId } = await this.signingCertificateEnrollment!.startEnrollment(mailbox.primarySmtpAddress, body.csr);
        const attachWrappedKey: ((enrollmentId: string, wrappedKey: unknown, binding: unknown) => Promise<void>) | undefined = (
            this.signingCertificateEnrollment as any
        ).attachWrappedKey;
        if (typeof attachWrappedKey === "function") {
            // The generation the wrapped key is sealed under - the client's own when it said which (checked equal to the
            // vault's just above), else the vault's as read before the CA call - so the driver job never installs it
            // after a rotation (see `KeyVault.masterKeyGeneration`), including one that lands during `startEnrollment()`.
            await attachWrappedKey.call(this.signingCertificateEnrollment, enrollmentId, body.wrappedKey, {
                mailboxUid: mailbox.uid,
                masterKeyGeneration: expectedGeneration ?? generationOf(keyVault),
            });
        }

        return { enrollmentId };
    }

    /** Reports the current status of a previously started automated enrollment - see `startSignEnrollment()` - and how far along
     * it is (`EnrollmentProgress`: `stage`, `stages`, `progress`, timestamps, and for a failure `errorCode`/`retryable`; every field
     * beyond `status`/`certificate`/`error` is additive). Only an enrollment of the path mailbox (`requireEnrollmentOf()`) - any
     * other id is a `404`, so mailbox access to one mailbox doesn't read another mailbox's enrollment. */
    @Get("/:id/keyvault/keys/sign-enrollment/:enrollmentId")
    public async checkSignEnrollmentStatus(
        @Param("id") mailboxId: string,
        @Param("enrollmentId") enrollmentId: string,
        @AuthUser user?: JWTUser,
    ): Promise<EnrollmentProgress> {
        const mailbox: M = await this.requireMailbox(mailboxId);
        await this.requireMailboxAccess(mailbox, user, ACLAction.READ);
        await this.requireEnrollmentOf(mailbox, enrollmentId);

        return await this.enrollmentProgress(enrollmentId);
    }

    /**
     * The mailbox's CURRENT signing-certificate enrollment - one still in flight (pending, or issued and not yet installed) - or, when
     * none is, its most recent one, in the same shape as `checkSignEnrollmentStatus()` plus its `enrollmentId`: how a client on
     * another device, or with its storage cleared, finds an enrollment it never saw start. `404` when the mailbox has never enrolled
     * (also for an implementation that keeps no list: the `Null` default, which has no enrollments).
     */
    @Get("/:id/keyvault/keys/sign-enrollment")
    public async currentSignEnrollment(
        @Param("id") mailboxId: string,
        @AuthUser user?: JWTUser,
    ): Promise<EnrollmentProgress & { enrollmentId: string }> {
        const mailbox: M = await this.requireMailbox(mailboxId);
        await this.requireMailboxAccess(mailbox, user, ACLAction.READ);

        const all: EnrollmentSummary[] = (await this.signingCertificateEnrollment!.listEnrollments?.()) ?? [];
        const own: EnrollmentSummary[] = all
            .filter((enrollment) => this.enrollmentBelongsTo(enrollment, mailbox))
            .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        const current: EnrollmentSummary | undefined =
            own.find((enrollment) => enrollment.status === "pending" || (enrollment.status === "issued" && !enrollment.installedAt)) ?? own[0];
        if (!current) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        return { enrollmentId: current.enrollmentId, ...(await this.enrollmentProgress(current.enrollmentId)) };
    }

    /**
     * Checks a pending enrollment right now instead of waiting for the background job's next tick - answering the CA's
     * challenge, polling the order, downloading the certificate - and answers with the same object as
     * `checkSignEnrollmentStatus()`. Whoever may read the enrollment may ask (the owner or a delegate with READ); it changes
     * nothing that isn't already due. **Rate limited per enrollment**: asking again within about 10 seconds is a `429` with
     * `Retry-After`. **Bounded**: it never waits on the CA for more than a few seconds - a slow CA leaves the check running and
     * the answer carries the current state and a `note`. A finished enrollment is answered as it is (no CA call, no limit).
     */
    @Post("/:id/keyvault/keys/sign-enrollment/:enrollmentId/check")
    public async checkSignEnrollmentNow(
        @Param("id") mailboxId: string,
        @Param("enrollmentId") enrollmentId: string,
        @Response res: HttpResponse,
        @AuthUser user?: JWTUser,
    ): Promise<EnrollmentProgress> {
        const mailbox: M = await this.requireMailbox(mailboxId);
        await this.requireMailboxAccess(mailbox, user, ACLAction.READ);
        await this.requireEnrollmentOf(mailbox, enrollmentId);

        if (typeof this.signingCertificateEnrollment!.checkNow !== "function") {
            // Nothing to poll (an enrollment an administrator completes by hand): the current state is the answer.
            return await this.enrollmentProgress(enrollmentId);
        }
        try {
            return await this.signingCertificateEnrollment!.checkNow(enrollmentId);
        } catch (err: any) {
            if (err?.status === 429 && typeof err.retryAfterSeconds === "number") {
                res.setHeader("Retry-After", String(err.retryAfterSeconds));
            }
            throw err;
        }
    }

    /** The enrollment's status with its progress - `describeProgress()` where the implementation has it, else the plain status. */
    private async enrollmentProgress(enrollmentId: string): Promise<EnrollmentProgress> {
        const enrollment: SigningCertificateEnrollment = this.signingCertificateEnrollment!;
        const progress: EnrollmentProgress =
            typeof enrollment.describeProgress === "function"
                ? await enrollment.describeProgress(enrollmentId)
                : ((await enrollment.checkStatus(enrollmentId)) as EnrollmentProgress);
        // `provider` on every status: an implementation that reports its own wins, the others are told apart by what they are.
        return { ...progress, provider: progress.provider ?? providerKindOf(enrollment) };
    }

    /**
     * Cancels one of the mailbox's pending (or issued but not yet installed) automated signing enrollments: nothing is
     * installed from it afterwards. Owner-only, like every key-vault write. `rekey()` refuses to run while such an
     * enrollment exists, so this is how an owner with an enrollment stuck at the CA gets to rotate their keys.
     */
    @Delete("/:id/keyvault/keys/sign-enrollment/:enrollmentId")
    public async cancelSignEnrollment(
        @Param("id") mailboxId: string,
        @Param("enrollmentId") enrollmentId: string,
        @AuthUser user?: JWTUser,
    ): Promise<EnrollmentProgress> {
        const mailbox: M = await this.requireMailbox(mailboxId);
        this.requireMailboxOwner(mailbox, user);
        const found: "own" | "other" | "unknown" = await this.findEnrollmentOf(mailbox, enrollmentId);
        if (found === "unknown") {
            // Cancelling is idempotent: an id this backend doesn't know (typically one left over from the backend a deployment used before) is already as
            // cancelled as it can be. Answered in the shape of a cancelled request, so a client clears its stale id and offers a new request.
            return this.unknownEnrollmentProgress();
        }
        if (found === "other") {
            throw new ApiError(SIGNING_ENROLLMENT_UNKNOWN, 404, "No signing certificate request with this id exists for this mailbox.");
        }
        if (typeof this.signingCertificateEnrollment!.cancelEnrollment !== "function") {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        await this.signingCertificateEnrollment!.cancelEnrollment(enrollmentId, "Cancelled by the mailbox owner.");
        return await this.enrollmentProgress(enrollmentId);
    }

    /**
     * Refuses (404) an `enrollmentId` that doesn't belong to `mailbox`: one recorded for another mailbox uid, or - with no
     * uid recorded - started for another address. Enrollment ids are the only handle on an enrollment, so without this
     * any caller with access to one mailbox could read (or cancel) every other mailbox's enrollment by id. Fails closed
     * on an implementation that can't say (`describeEnrollment()` absent).
     */
    private async requireEnrollmentOf(mailbox: M, enrollmentId: string): Promise<void> {
        if ((await this.findEnrollmentOf(mailbox, enrollmentId)) !== "own") {
            // Always this code, for an id the active backend doesn't know and for another mailbox's alike (which one it is stays private): the client
            // clears its stale id and lets the user request again.
            throw new ApiError(SIGNING_ENROLLMENT_UNKNOWN, 404, "No signing certificate request with this id exists for this mailbox.");
        }
    }

    /** Whether `enrollmentId` is an enrollment of the active backend that belongs to `mailbox` (`"own"`), belongs to another (`"other"`), or is not one the
     * backend knows (`"unknown"`). A failure of the backend itself (5xx, e.g. the `Null` default's "not available") propagates. */
    private async findEnrollmentOf(mailbox: M, enrollmentId: string): Promise<"own" | "other" | "unknown"> {
        const describe = this.signingCertificateEnrollment?.describeEnrollment;
        let binding: EnrollmentBinding | undefined;
        try {
            binding = typeof describe === "function" ? await describe.call(this.signingCertificateEnrollment, enrollmentId) : undefined;
        } catch (err: any) {
            // An unknown id is a 404 like any other mismatch; "not available" (the Null default) stays what it is.
            if (typeof err?.status === "number" && err.status >= 500) {
                throw err;
            }
            binding = undefined;
        }
        if (!binding) {
            return "unknown";
        }
        return this.enrollmentBelongsTo(binding, mailbox) ? "own" : "other";
    }

    /** The answer to cancelling a request the backend does not know: a cancelled, retryable one with nothing left to show. */
    private unknownEnrollmentProgress(): EnrollmentProgress {
        const now: string = new Date().toISOString();
        return {
            provider: providerKindOf(this.signingCertificateEnrollment!),
            status: "failed",
            error: "This request no longer exists.",
            stage: "failed",
            stages: [],
            progress: 0,
            requestedAt: now,
            updatedAt: now,
            errorCode: "cancelled",
            retryable: true,
        };
    }

    private enrollmentBelongsTo(binding: { identity: string; mailboxUid?: string }, mailbox: M): boolean {
        return binding.mailboxUid
            ? binding.mailboxUid === mailbox.uid
            : normalizeAddress(String(binding.identity)) === normalizeAddress(mailbox.primarySmtpAddress);
    }

    /**
     * Refuses (409) while `mailbox` has an automated signing enrollment that is pending, or issued but not yet
     * installed, holding a wrapped private key. That key is sealed under the vault's CURRENT master key; installed after
     * a rotation it would become the active signing key under a master key nobody can open any more, and unlocking
     * with the right password would fail for good.
     *
     * Refusing is chosen over cancelling the enrollment on the owner's behalf: an enrollment may be days into a CA's
     * email challenge, and silently throwing that away (the CA still issues, the certificate is just never installed)
     * is worse than asking the owner to wait for it or cancel it explicitly (`cancelSignEnrollment()`). The driver job's
     * own master-key-generation check still covers an enrollment started concurrently with the rotation.
     */
    private async assertNoPendingSignEnrollment(mailbox: M): Promise<void> {
        const list = (this.signingCertificateEnrollment as any)?.listPendingEnrollments;
        if (typeof list !== "function") {
            return;
        }
        const pending: Array<{ identity: string; mailboxUid?: string; hasWrappedKey?: boolean }> = await list.call(this.signingCertificateEnrollment);
        if (pending.some((enrollment) => enrollment.hasWrappedKey !== false && this.enrollmentBelongsTo(enrollment, mailbox))) {
            throw new ApiError(
                ApiErrors.IDENTIFIER_EXISTS,
                409,
                "A signing certificate enrollment for this mailbox is still in progress - wait for it to finish, or cancel it, before rotating keys.",
            );
        }
    }

    /**
     * Adds a wrapped copy of the mailbox's master key for a new unlock method (e.g. registering a new
     * passkey), independent of key enrollment. Requires an already-initialized vault (`404` otherwise) -
     * there is no master key to wrap yet for a mailbox that has never enrolled its first key via
     * `enrollKey()`.
     */
    @Post("/:id/keyvault/wraps")
    public async addMasterKeyWrap(
        @Param("id") mailboxId: string,
        body: AddMasterKeyWrapRequest,
        @AuthUser user?: JWTUser,
    ): Promise<PublicKeyVault> {
        const mailbox: M = await this.requireMailbox(mailboxId);
        this.requireMailboxOwner(mailbox, user);
        validateMasterKeyWrap(body, { allowEscrow: await this.resolveAllowEscrow(mailbox, body) });
        const expectedGeneration: number | undefined = readExpectedGeneration(body);
        // Not part of the wrap - never stored with it.
        const wrap: MasterKeyWrap & ExpectedMasterKeyGeneration = { ...body };
        delete wrap.expectedMasterKeyGeneration;

        const keyVault: K | undefined = await this.findKeyVault(mailboxId);
        if (!keyVault) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, "This mailbox has not enrolled a key yet.");
        }
        // A new wrap of an old master key would unlock nothing the vault holds now. The update below is version-checked,
        // so a rekey landing after this read is a 409 as well.
        assertMasterKeyGeneration(keyVault, expectedGeneration);
        if (keyVault.masterKeyWraps.length >= MAX_MASTER_KEY_WRAPS) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `A key vault cannot hold more than ${MAX_MASTER_KEY_WRAPS} master key wraps.`);
        }

        const updated: K = await this.keyVaultRepo!.update(
            {
                uid: keyVault.uid,
                version: (keyVault as any).version,
                masterKeyWraps: [...keyVault.masterKeyWraps, pickMasterKeyWrap(wrap)],
            } as any,
            keyVault,
            { ignoreACL: true },
        );

        await this.auditLogUtils!.record(
            {
                action: AuditAction.KEY_VAULT_WRAP_ADD,
                targetType: "KeyVault",
                targetUid: keyVault.uid,
                mailboxUid: mailbox.uid,
                details: { method: body.method, methodId: body.methodId },
            },
            { user },
        );

        return toPublicKeyVault(updated, mailbox);
    }

    /**
     * Removes a wrapped copy of the master key for one unlock method - identified by `method` plus
     * `methodId` (required whenever more than one wrap could share the same `method`, e.g. multiple
     * passkeys; omit it only for a method a mailbox has at most one of).
     *
     * **This alone does not revoke access** - see `MasterKeyWrap`'s own doc comment: anyone who already
     * captured the wrapped blob and holds the corresponding secret can still unwrap it. True revocation is
     * `rekey()` (D4).
     */
    @Delete("/:id/keyvault/wraps/:method")
    public async removeMasterKeyWrap(
        @Param("id") mailboxId: string,
        @Param("method") method: string,
        @Query("methodId") methodId: string | undefined,
        @AuthUser user?: JWTUser,
    ): Promise<PublicKeyVault> {
        const mailbox: M = await this.requireMailbox(mailboxId);
        this.requireMailboxOwner(mailbox, user);
        // See `validateMasterKeyWrap()`'s doc comment - the mailbox owner/delegate path must never be able to
        // remove a compliance-installed escrow wrap themselves.
        if (method === "escrow") {
            throw new ApiError(
                ApiErrors.AUTH_PERMISSION_FAILURE,
                403,
                "Escrow wraps are managed by the compliance/eDiscovery role and cannot be removed through this endpoint.",
            );
        }

        const keyVault: K | undefined = await this.findKeyVault(mailboxId);
        if (!keyVault) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, "This mailbox has not enrolled a key yet.");
        }

        const matching: MasterKeyWrap[] = keyVault.masterKeyWraps.filter(
            (w) => w.method === method && (methodId === undefined || w.methodId === methodId),
        );
        if (matching.length === 0) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, "No matching master key wrap was found.");
        }
        // `methodId` is required whenever more than one wrap could share `method` (see this method's own doc
        // comment) - without this check, omitting it while two-or-more such wraps exist would silently delete
        // all of them in one call instead of rejecting the ambiguous request.
        if (methodId === undefined && matching.length > 1) {
            throw new ApiError(
                ApiErrors.INVALID_REQUEST,
                400,
                `This mailbox has ${matching.length} master key wraps for method '${method}' - methodId is required to disambiguate which one to remove.`,
            );
        }
        const remaining: MasterKeyWrap[] = keyVault.masterKeyWraps.filter((w) => !matching.includes(w));
        // The owner's own unlock methods are every non-escrow wrap - removing the last one would leave the master
        // key recoverable only through escrow (or not at all), locking the owner out of their encrypted mail.
        if (!remaining.some((w) => w.method !== "escrow")) {
            throw new ApiError(
                ApiErrors.IDENTIFIER_EXISTS,
                409,
                "This is the mailbox's last master key wrap - add another unlock method before removing it.",
            );
        }

        const updated: K = await this.keyVaultRepo!.update(
            { uid: keyVault.uid, version: (keyVault as any).version, masterKeyWraps: remaining } as any,
            keyVault,
            { ignoreACL: true },
        );

        await this.auditLogUtils!.record(
            { action: AuditAction.KEY_VAULT_WRAP_REMOVE, targetType: "KeyVault", targetUid: keyVault.uid, mailboxUid: mailbox.uid, details: { method, methodId } },
            { user },
        );

        return toPublicKeyVault(updated, mailbox);
    }

    /**
     * `POST /mailbox/:id/keyvault/exports` - records that the owner exported private keys from their vault ("Export keys for
     * Outlook/phone", `specs/search.md` §3). The export itself happens entirely in the client from a fresh master-password
     * unlock; this only writes the `KEY_VAULT_EXPORT` audit entry, with the kind and fingerprint of each exported key and
     * nothing else. Owner-only like every vault operation, and only for keys this mailbox actually has, so the audit log never
     * records a fingerprint the mailbox doesn't own. The client won't hand over the file until this succeeds.
     */
    @Post("/:id/keyvault/exports")
    public async recordExport(@Param("id") mailboxId: string, body: KeyExportRecord, @AuthUser user?: JWTUser): Promise<void> {
        const mailbox: M = await this.requireMailbox(mailboxId);
        this.requireMailboxOwner(mailbox, user);

        const keys: KeyExportRecord["keys"] = Array.isArray(body?.keys) ? body.keys : [];
        if (keys.length === 0 || keys.length > MAX_EXPORTED_KEYS) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `keys must list between 1 and ${MAX_EXPORTED_KEYS} exported keys.`);
        }
        const known: Set<string> = new Set([...(mailbox.keys ?? []), ...(mailbox.zeroAccessKeys ?? [])].map((k) => `${k.useType}:${k.fingerprint}`));
        for (const key of keys) {
            if (!EXPORTED_KEY_KINDS.includes(key?.kind) || typeof key.fingerprint !== "string" || !known.has(`${key.kind}:${key.fingerprint}`)) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "keys must name this mailbox's own zero-access, encryption or signing keys.");
            }
        }

        // A phone or Outlook with the exported zero-access key installed reads protected mail: what the default for mail goes by.
        if (keys.some((key) => key.kind === "zero-access")) {
            await this.mailboxRepo!.update({ uid: mailbox.uid, version: (mailbox as any).version, zeroAccessKeysExportedAt: Date.now() } as any, mailbox, {
                ignoreACL: true,
            });
        }
        await this.auditLogUtils!.record(
            {
                action: AuditAction.KEY_VAULT_EXPORT,
                targetType: "KeyVault",
                targetUid: mailbox.uid,
                mailboxUid: mailbox.uid,
                details: { keys: keys.map(({ kind, fingerprint }) => ({ kind, fingerprint })) },
            },
            { user },
        );
    }

    /**
     * Refused (409) while the mailbox has an automated signing enrollment in flight (`assertNoPendingSignEnrollment()`),
     * and when it would drop the mailbox's escrow coverage without a replacement (`assertEscrowCarriedOver()`). Escrow
     * wraps in the request are accepted for the mailbox's assigned scope only, as in `addMasterKeyWrap()`; old ones are
     * never kept.
     *
     * Full, atomic replacement of a mailbox's `wrappedKeys`/`masterKeyWraps` (and published `keys`), following
     * the client's own re-key operation - the only real revocation mechanism for a captured wrap (see
     * `MasterKeyWrap`'s doc comment). Purely client-initiated: this repo has no session/device-revocation
     * concept today (the ActiveSync plugin's `DeviceSyncState` is EAS sync-cursor state, not session revocation), so this is scoped as
     * "the client calls this after doing its own re-key," not tied to a revocation feature that doesn't exist
     * yet. Requires an already-initialized vault (`404` otherwise) - there is nothing to re-key for a mailbox
     * that has never enrolled a key.
     *
     * Restricted to the mailbox's actual owner (`requireMailboxOwner()`, not `requireMailboxAccess()`) - see
     * that method's own doc comment.
     *
     * `body.keys` is validated, not trusted wholesale like the rest of this method's own doc comment might
     * suggest: every entry MUST already be present (same `fingerprint`) in the mailbox's current `keys`, with
     * every field identical except `revokedAt`. Genuinely new key material MUST be enrolled via `enrollKey()`
     * first, which alone talks to the CA - without this check, `rekey()` was a second, completely unvalidated
     * path to publish an arbitrary "certificate" at the public discovery endpoint, bypassing the CA entirely.
     * `rekey()`'s real purpose - re-wrapping the master key under new/changed unlock methods, and optionally
     * marking an existing key revoked - never requires introducing a fingerprint the CA hasn't already issued.
     *
     * Each published key is rebuilt from the stored one (`rekeyedKey()`): `issuerCertificate` may be omitted (the stored
     * one is kept) or repeated unchanged, anything else is a `400`; `revokedAt`/`revocationReason` may differ: a stored
     * revocation is kept (it can't be withdrawn, only escalated from `"superseded"` to `"compromised"`), and a request may
     * revoke a key (reason `"compromised"` unless it says otherwise). Then every unrevoked key that isn't its `useType`'s active one is
     * revoked (`revokeInactiveKeys()`), which normalizes mailboxes enrolled before superseded keys were revoked.
     */
    @Put("/:id/keyvault/rekey")
    public async rekey(@Param("id") mailboxId: string, body: RekeyRequest, @AuthUser user?: JWTUser): Promise<PublicKeyVault> {
        const mailbox: M = await this.requireMailbox(mailboxId);
        this.requireMailboxOwner(mailbox, user);

        const keyVault: K | undefined = await this.findKeyVault(mailboxId);
        if (!keyVault) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, "This mailbox has not enrolled a key yet.");
        }

        // A rekey REPLACES the vault wholesale, so every list is required - a missing one used to be read as "empty"
        // (wiping every published key or wrapped private key) or crash `persistRekey()` after the mailbox was
        // already written.
        for (const field of ["wrappedKeys", "masterKeyWraps", "keys"] as const) {
            if (!Array.isArray(body?.[field])) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `${field} must be an array.`);
            }
        }
        // At least one wrap the owner can unlock with - with none, the new master key is lost to the owner (the same
        // rule `removeMasterKeyWrap()` enforces for a single removal).
        if (!body.masterKeyWraps.some((wrap) => wrap?.method !== "escrow")) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "masterKeyWraps must include at least one non-escrow wrap.");
        }

        const rekeyedAt: number = Date.now();
        const existingByFingerprint = new Map((mailbox.keys ?? []).map((k) => [k.fingerprint, k]));
        const keys: PublicKey[] = [];
        for (const key of body.keys) {
            const existing: PublicKey | undefined = existingByFingerprint.get(key?.fingerprint);
            if (
                !existing ||
                existing.publicKey !== key.publicKey ||
                existing.type !== key.type ||
                existing.useType !== key.useType ||
                existing.notBefore !== key.notBefore ||
                existing.notAfter !== key.notAfter ||
                // Absent (or null) keeps the stored one; anything else must match it exactly.
                (key.issuerCertificate !== undefined && key.issuerCertificate !== null && key.issuerCertificate !== existing.issuerCertificate)
            ) {
                throw new ApiError(
                    ApiErrors.INVALID_REQUEST,
                    400,
                    "Every key in a rekey request must already be enrolled (via enrollKey) with identical fields aside from revokedAt.",
                );
            }
            const rawRevokedAt: unknown = key.revokedAt ?? undefined;
            if (rawRevokedAt !== undefined && !(typeof rawRevokedAt === "number" && Number.isFinite(rawRevokedAt))) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "revokedAt must be a number of epoch milliseconds.");
            }
            const requestedRevokedAt: number | undefined = typeof rawRevokedAt === "number" ? rawRevokedAt : undefined;
            const requestedReason: unknown = key.revocationReason ?? undefined;
            if (requestedReason !== undefined && !REVOCATION_REASONS.includes(requestedReason as any)) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `revocationReason must be one of: ${REVOCATION_REASONS.join(", ")}.`);
            }
            keys.push(
                rekeyedKey(existing, {
                    revokedAt: requestedRevokedAt,
                    revocationReason: requestedReason as PublicKey["revocationReason"],
                }),
            );
        }
        if ((body.masterKeyWraps ?? []).length > MAX_MASTER_KEY_WRAPS) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `masterKeyWraps cannot exceed ${MAX_MASTER_KEY_WRAPS} entries.`);
        }
        for (const wrap of body.masterKeyWraps ?? []) {
            validateMasterKeyWrap(wrap, { allowEscrow: await this.resolveAllowEscrow(mailbox, wrap) });
        }
        await this.assertEscrowCarriedOver(mailbox, keyVault, body.masterKeyWraps);
        if ((body.wrappedKeys ?? []).length > MAX_ENROLLED_KEYS) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `wrappedKeys cannot exceed ${MAX_ENROLLED_KEYS} entries.`);
        }
        for (const wrappedKey of body.wrappedKeys ?? []) {
            validateWrappedPrivateKey(wrappedKey);
        }

        // The generation of the vault the client re-keyed from: a device that missed another device's rotation would
        // otherwise replace the newer vault (and any key enrolled under it) with its own.
        assertMasterKeyGeneration(keyVault, readExpectedGeneration(body));

        await this.assertNoPendingSignEnrollment(mailbox);

        const updated: K = await this.persistRekey(mailbox, keyVault, { ...body, keys: revokeInactiveKeys(keys, rekeyedAt) });

        await this.auditLogUtils!.record(
            { action: AuditAction.KEY_VAULT_REKEY, targetType: "KeyVault", targetUid: keyVault.uid, mailboxUid: mailbox.uid },
            { user },
        );

        return toPublicKeyVault(updated, mailbox);
    }

    /**
     * Keeps `removeMasterKeyWrap()`'s rule - the owner can't take away escrow coverage - across a rotation, which
     * replaces every wrap: when the mailbox is assigned to an escrow scope that still exists and the vault holds an
     * escrow wrap for that scope, the rekey must carry a new escrow wrap for it (409 otherwise). Otherwise a "rekey"
     * that re-submitted the owner's own wraps for the same master key would strip a working escrow wrap. Escrow wraps
     * for any other scope (a scope the mailbox has since left) are simply dropped. `validateMasterKeyWrap()` has
     * already refused an escrow wrap in the request for any scope but the assigned one.
     */
    private async assertEscrowCarriedOver(mailbox: M, keyVault: K, requested: MasterKeyWrap[]): Promise<void> {
        const scopeId: string | undefined = mailbox.escrowScopeId || undefined;
        if (!scopeId || !keyVault.masterKeyWraps.some((wrap) => wrap.method === "escrow" && wrap.escrowScopeId === scopeId)) {
            return;
        }
        if (requested.some((wrap) => wrap.method === "escrow" && wrap.escrowScopeId === scopeId)) {
            return;
        }
        if (!(await this.escrowScopeRepo!.findOne(scopeId, { ignoreACL: true }))) {
            return;
        }
        throw new ApiError(
            ApiErrors.IDENTIFIER_EXISTS,
            409,
            "This mailbox's master key is escrowed - a rekey must include a new escrow wrap for its escrow scope.",
        );
    }

    @Transactional()
    protected async persistRekey(mailbox: M, keyVault: K, body: RekeyRequest): Promise<K> {
        await this.mailboxRepo!.update(
            { uid: mailbox.uid, version: (mailbox as any).version, keys: body.keys } as any,
            mailbox,
            { ignoreACL: true },
        );
        // Every old wrap is replaced, escrow wraps included: they wrap the old master key, so kept they would open
        // nothing, pile up against `MAX_MASTER_KEY_WRAPS` (the owner can't remove them) and keep key discovery
        // reporting escrow coverage that no longer exists. `assertEscrowCarriedOver()` has already required a
        // replacement escrow wrap wherever dropping the old one would take away coverage the deployment assigned.
        // `masterKeyGeneration` moves on, so an enrollment holding a key sealed under the old master key is never
        // installed (`AcmeEnrollmentDriverJob`).
        return await this.keyVaultRepo!.update(
            {
                uid: keyVault.uid,
                version: (keyVault as any).version,
                wrappedKeys: body.wrappedKeys.map(pickWrappedKey),
                masterKeyWraps: body.masterKeyWraps.map(pickMasterKeyWrap),
                masterKeyGeneration: (keyVault.masterKeyGeneration ?? 0) + 1,
            } as any,
            keyVault,
            { ignoreACL: true },
        );
    }
}
