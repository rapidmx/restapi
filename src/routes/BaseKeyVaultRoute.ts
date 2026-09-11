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
    ObjectFactory,
    RepoUtils,
    RouteDecorators,
} from "@rapidrest/service-core";
import { EncryptionCertificateAuthority } from "../pki/EncryptionCertificateAuthority.js";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { AuditAction, KeyVault, Mailbox, MasterKeyWrap, PublicKey, WrappedPrivateKey } from "../models/types.js";
const { Config, Inject, Logger } = ObjectDecorators;
const { Transactional } = DatabaseDecorators;
const { Delete, Get, Param, Post, Put, Query, User: AuthUser } = RouteDecorators;

/** The wire shape `GET /mailbox/:id/keyvault` returns - identical to the `KeyVault` entity minus its own
 * bookkeeping fields (`uid`/`mailboxUid`/etc.), matching `specs/end-to-end_encryption.md`'s own `KeyVault`
 * type exactly. */
export type PublicKeyVault = Pick<KeyVault, "wrappedKeys" | "masterKeyWraps">;

const EMPTY_KEY_VAULT: PublicKeyVault = { wrappedKeys: [], masterKeyWraps: [] };

/** Request body for `enrollKey()`. `wrappedKey`'s `fingerprint`/`useType` are deliberately omitted - the
 * server derives both from the actual issued/validated certificate, never trusting a client-asserted value
 * for either (see `enrollKey()`'s own doc comment). `masterKeyWraps` is only meaningful - and only persisted -
 * the very first time a mailbox enrolls a key at all (bootstrapping its master key); enrolling a second key
 * onto an already-initialized vault ignores it, since adding a master-key wrap independent of key enrollment
 * is `addMasterKeyWrap()`'s (D3's) job, not this one's. */
export interface EnrollKeyRequest {
    useType: "sign" | "encrypt";
    /** A PEM-encoded PKCS#10 CSR - required, and only meaningful, when `useType` is `"encrypt"`: the server
     * calls the injected `EncryptionCertificateAuthority` itself to mint the certificate. */
    csr?: string;
    /** An already-issued PEM certificate - required, and only meaningful, when `useType` is `"sign"`: signing
     * certificates are enrolled asynchronously against a public CA via the separate
     * `SigningCertificateEnrollment` flow (`startEnrollment()`/`checkStatus()`), which has already completed
     * by the time this call is made - this endpoint only validates and installs the result. */
    certificate?: string;
    wrappedKey: Omit<WrappedPrivateKey, "fingerprint" | "useType">;
    masterKeyWraps?: MasterKeyWrap[];
}

/** Request body for `addMasterKeyWrap()`. */
export type AddMasterKeyWrapRequest = MasterKeyWrap;

/** Request body for `rekey()` - a full, atomic replacement of a mailbox's entire key-vault contents, following
 * the client's own re-key operation (see `MasterKeyWrap`'s doc comment on why removing a wrap alone never
 * revokes access). */
export interface RekeyRequest {
    wrappedKeys: WrappedPrivateKey[];
    masterKeyWraps: MasterKeyWrap[];
    /** The mailbox's replacement `PublicKey` list, published alongside the re-keyed vault - a re-key is
     * usually, though not necessarily, paired with fresh key material. */
    keys: PublicKey[];
}

/**
 * Implements `specs/end-to-end_encryption.md`'s key-vault endpoints (`GET`/enroll/wrap-CRUD/re-key under
 * `/mailbox/:id/keyvault`) - a bespoke class (own `init()`-built `RepoUtils`, no `@Model`-driven CRUD, same
 * shape as `BaseEncryptionPolicyRoute`/`BaseBookingRoute`), because this is private key material, not an
 * ordinary collection.
 *
 * **Access is checked directly against the owning mailbox's `AccessControlList` and deliberately excludes the
 * usual trusted/admin bypass** (`ACLUtils.hasPermission()`'s built-in "trusted users always have permission"
 * short-circuit - confirmed by reading `ACLUtils.js` - is never called here): a system admin gets a `403`
 * unless they are literally the mailbox's `ownerUserUid` or hold an explicit delegate `ACLRecord` on it,
 * `getRecord()` (which has no such bypass) is used instead. Every mutating action here is audit-logged
 * regardless of caller, so any admin access that *does* occur through a genuine delegate grant is still
 * visible after the fact.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseKeyVaultRoute<K extends KeyVault, M extends Mailbox> {
    protected abstract keyVaultClass: any;
    protected abstract mailboxClass: any;
    protected abstract auditLogClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private keyVaultRepo?: RepoUtils<K>;
    private mailboxRepo?: RepoUtils<M>;

    @Inject(ACLUtils)
    private aclUtils?: ACLUtils;

    @Inject("EncryptionCertificateAuthority")
    private encryptionCa?: EncryptionCertificateAuthority;

    /** Exposes the `@Model(...)`-supplied entity class so `@Transactional()` on `enrollKey()`/`rekey()` can
     * resolve which datasource to open a transaction against - identical reasoning to `BaseBookingRoute`'s own
     * `modelClass` getter. */
    public get modelClass(): any {
        return (this.constructor as any).modelClass;
    }

    /** The whole application config, needed only to pass through to `recordAuditLog()` (`caller.config`). */
    @Config()
    private config: any;

    @Logger
    private logger: any;

    private async init(): Promise<void> {
        if (!this.keyVaultRepo) {
            this.keyVaultRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.keyVaultClass.name,
                args: [this.keyVaultClass],
            });
        }
        if (!this.mailboxRepo) {
            this.mailboxRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.mailboxClass.name,
                args: [this.mailboxClass],
            });
        }
    }

    private async requireMailbox(mailboxId: string): Promise<M> {
        const mailbox: M | undefined = await this.mailboxRepo!.findOne(mailboxId, { ignoreACL: true });
        if (!mailbox) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
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

    private async findKeyVault(mailboxUid: string): Promise<K | undefined> {
        const existing: K[] = await this.keyVaultRepo!.find({ mailboxUid } as any, { ignoreACL: true, limit: 1 });
        return existing[0];
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
        await this.init();
        const mailbox: M = await this.requireMailbox(mailboxId);
        await this.requireMailboxAccess(mailbox, user, ACLAction.READ);

        const existing: K | undefined = await this.findKeyVault(mailboxId);
        return existing ? { wrappedKeys: existing.wrappedKeys, masterKeyWraps: existing.masterKeyWraps } : EMPTY_KEY_VAULT;
    }

    /** Normalizes a `crypto.X509Certificate`'s colon-separated-hex fingerprint to the same lowercase,
     * no-separator hex format `EncryptionCertificateAuthority.issue()` already produces (see
     * `LocalX509CertificateAuthority`/`OpenBaoPkiCertificateAuthority`'s own `getThumbprint()`-derived
     * fingerprints), so a `PublicKey.fingerprint` looks the same regardless of which code path derived it. */
    private static normalizeFingerprint(fingerprint256: string): string {
        return fingerprint256.replace(/:/g, "").toLowerCase();
    }

    private static publicKeyFromCertificatePem(
        certificatePem: string,
        useType: "sign" | "encrypt",
    ): { publicKey: PublicKey; fingerprint: string } {
        let cert: crypto.X509Certificate;
        try {
            cert = new crypto.X509Certificate(certificatePem);
        } catch {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The provided certificate could not be parsed.");
        }
        const fingerprint: string = BaseKeyVaultRoute.normalizeFingerprint(cert.fingerprint256);
        return {
            fingerprint,
            publicKey: {
                publicKey: cert.raw.toString("base64"),
                type: "x509",
                useType,
                fingerprint,
                notBefore: new Date(cert.validFrom).getTime(),
                notAfter: new Date(cert.validTo).getTime(),
            },
        };
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
        await this.init();
        const mailbox: M = await this.requireMailbox(mailboxId);
        await this.requireMailboxAccess(mailbox, user, ACLAction.UPDATE);

        if (!body?.wrappedKey) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "wrappedKey is required.");
        }

        let publicKey: PublicKey;
        let fingerprint: string;
        if (body.useType === "encrypt") {
            if (!body.csr) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "csr is required for useType 'encrypt'.");
            }
            const issued = await this.encryptionCa!.issue(mailbox.primarySmtpAddress, body.csr);
            const der: Buffer = new crypto.X509Certificate(issued.certificate).raw;
            fingerprint = issued.fingerprint;
            publicKey = {
                publicKey: der.toString("base64"),
                type: "x509",
                useType: "encrypt",
                fingerprint,
                notBefore: issued.notBefore.getTime(),
                notAfter: issued.notAfter.getTime(),
            };
        } else if (body.useType === "sign") {
            if (!body.certificate) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "certificate is required for useType 'sign'.");
            }
            const result = BaseKeyVaultRoute.publicKeyFromCertificatePem(body.certificate, "sign");
            publicKey = result.publicKey;
            fingerprint = result.fingerprint;
        } else {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "useType must be 'sign' or 'encrypt'.");
        }

        const collision: PublicKey | undefined = mailbox.keys.find((k) => k.fingerprint === fingerprint);
        if (collision && !collision.revokedAt && collision.notAfter > Date.now()) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "A non-expired, non-revoked key with this fingerprint is already enrolled.");
        }

        const wrappedKey: WrappedPrivateKey = { ...body.wrappedKey, fingerprint, useType: body.useType };

        const persisted = await this.persistEnrollment(mailbox, publicKey, wrappedKey, body.masterKeyWraps);

        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, user, logger: this.logger },
            {
                action: AuditAction.KEY_VAULT_ENROLL,
                targetType: "KeyVault",
                targetUid: persisted.keyVault.uid,
                mailboxUid: mailbox.uid,
                details: { useType: body.useType, fingerprint },
            },
        );

        return { wrappedKeys: persisted.keyVault.wrappedKeys, masterKeyWraps: persisted.keyVault.masterKeyWraps };
    }

    @Transactional()
    protected async persistEnrollment(
        mailbox: M,
        publicKey: PublicKey,
        wrappedKey: WrappedPrivateKey,
        initialMasterKeyWraps: MasterKeyWrap[] | undefined,
    ): Promise<{ mailbox: M; keyVault: K }> {
        const updatedMailbox: M = await this.mailboxRepo!.update(
            { uid: mailbox.uid, version: (mailbox as any).version, keys: [...mailbox.keys, publicKey] } as any,
            mailbox,
            { ignoreACL: true },
        );

        const keyVault: K = await this.findOrCreateKeyVault(mailbox.uid);
        // `initialMasterKeyWraps` only takes effect while the vault has never had any wraps at all - adding a
        // wrap to an already-initialized vault is `addMasterKeyWrap()`'s (D3's) job, not this one's.
        const masterKeyWraps: MasterKeyWrap[] =
            keyVault.masterKeyWraps.length === 0 && initialMasterKeyWraps ? initialMasterKeyWraps : keyVault.masterKeyWraps;
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
        await this.init();
        const mailbox: M = await this.requireMailbox(mailboxId);
        await this.requireMailboxAccess(mailbox, user, ACLAction.UPDATE);

        const keyVault: K | undefined = await this.findKeyVault(mailboxId);
        if (!keyVault) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, "This mailbox has not enrolled a key yet.");
        }

        const updated: K = await this.keyVaultRepo!.update(
            {
                uid: keyVault.uid,
                version: (keyVault as any).version,
                masterKeyWraps: [...keyVault.masterKeyWraps, body],
            } as any,
            keyVault,
            { ignoreACL: true },
        );

        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, user, logger: this.logger },
            {
                action: AuditAction.KEY_VAULT_WRAP_ADD,
                targetType: "KeyVault",
                targetUid: keyVault.uid,
                mailboxUid: mailbox.uid,
                details: { method: body.method, methodId: body.methodId },
            },
        );

        return { wrappedKeys: updated.wrappedKeys, masterKeyWraps: updated.masterKeyWraps };
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
        await this.init();
        const mailbox: M = await this.requireMailbox(mailboxId);
        await this.requireMailboxAccess(mailbox, user, ACLAction.UPDATE);

        const keyVault: K | undefined = await this.findKeyVault(mailboxId);
        if (!keyVault) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, "This mailbox has not enrolled a key yet.");
        }

        const remaining: MasterKeyWrap[] = keyVault.masterKeyWraps.filter(
            (w) => !(w.method === method && (methodId === undefined || w.methodId === methodId)),
        );
        if (remaining.length === keyVault.masterKeyWraps.length) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, "No matching master key wrap was found.");
        }

        const updated: K = await this.keyVaultRepo!.update(
            { uid: keyVault.uid, version: (keyVault as any).version, masterKeyWraps: remaining } as any,
            keyVault,
            { ignoreACL: true },
        );

        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, user, logger: this.logger },
            { action: AuditAction.KEY_VAULT_WRAP_REMOVE, targetType: "KeyVault", targetUid: keyVault.uid, mailboxUid: mailbox.uid, details: { method, methodId } },
        );

        return { wrappedKeys: updated.wrappedKeys, masterKeyWraps: updated.masterKeyWraps };
    }

    /**
     * Full, atomic replacement of a mailbox's `wrappedKeys`/`masterKeyWraps` (and published `keys`), following
     * the client's own re-key operation - the only real revocation mechanism for a captured wrap (see
     * `MasterKeyWrap`'s doc comment). Purely client-initiated: this repo has no session/device-revocation
     * concept today (`DeviceSyncState` is EAS sync-cursor state, not session revocation), so this is scoped as
     * "the client calls this after doing its own re-key," not tied to a revocation feature that doesn't exist
     * yet. Requires an already-initialized vault (`404` otherwise) - there is nothing to re-key for a mailbox
     * that has never enrolled a key.
     */
    @Put("/:id/keyvault/rekey")
    public async rekey(@Param("id") mailboxId: string, body: RekeyRequest, @AuthUser user?: JWTUser): Promise<PublicKeyVault> {
        await this.init();
        const mailbox: M = await this.requireMailbox(mailboxId);
        await this.requireMailboxAccess(mailbox, user, ACLAction.UPDATE);

        const keyVault: K | undefined = await this.findKeyVault(mailboxId);
        if (!keyVault) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, "This mailbox has not enrolled a key yet.");
        }

        const updated: K = await this.persistRekey(mailbox, keyVault, body);

        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, user, logger: this.logger },
            { action: AuditAction.KEY_VAULT_REKEY, targetType: "KeyVault", targetUid: keyVault.uid, mailboxUid: mailbox.uid },
        );

        return { wrappedKeys: updated.wrappedKeys, masterKeyWraps: updated.masterKeyWraps };
    }

    @Transactional()
    protected async persistRekey(mailbox: M, keyVault: K, body: RekeyRequest): Promise<K> {
        await this.mailboxRepo!.update(
            { uid: mailbox.uid, version: (mailbox as any).version, keys: body.keys } as any,
            mailbox,
            { ignoreACL: true },
        );
        return await this.keyVaultRepo!.update(
            {
                uid: keyVault.uid,
                version: (keyVault as any).version,
                wrappedKeys: body.wrappedKeys,
                masterKeyWraps: body.masterKeyWraps,
            } as any,
            keyVault,
            { ignoreACL: true },
        );
    }
}
