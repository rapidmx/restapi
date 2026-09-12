///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { publicKeyFromCertificatePem } from "../util/CertificateInstallUtils.js";
import { AuditAction, KeyVault, Mailbox, PublicKey, WrappedPrivateKey } from "../models/types.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The `Rfc8823AcmeSigningCertificateEnrollment`-specific methods this job drives - see
 * `ScanQueueJob`'s identical `AcmeChallengeCorrelator` note on why this is a local, narrow shape rather
 * than an import of that concrete class or an addition to the shared `SigningCertificateEnrollment`
 * interface (`NullSigningCertificateEnrollment`/`ManualSigningCertificateEnrollment` have no use for any
 * of this - a deployment running either simply never has anything in `listPendingEnrollments()`). */
interface AcmeDrivenEnrollment {
    listPendingEnrollments?(): Promise<Array<{ enrollmentId: string; identity: string; status: "pending" | "issued" | "failed" }>>;
    advanceEnrollment?(enrollmentId: string): Promise<void>;
    getIssuedMaterial?(
        enrollmentId: string,
    ): Promise<{ certificate: string; wrappedKey: Omit<WrappedPrivateKey, "fingerprint" | "useType"> } | undefined>;
    markInstalled?(enrollmentId: string): Promise<void>;
}

/**
 * Drives every outstanding RFC 8823 enrollment forward, one `advanceEnrollment()` step per tick, and -
 * once the CA issues a certificate - auto-installs it into the mailbox's `KeyVault` with no further
 * client action, completing `specs/end-to-end_encryption.md`'s "MUST be automated" requirement end to
 * end from a single CSR+wrapped-key submission (`BaseKeyVaultRoute.startSignEnrollment()`). Also flags
 * (never auto-renews - this server can't originate a fresh client-side key pair) any mailbox's signing
 * certificate nearing expiry with nothing newer already enrolled.
 *
 * A no-op whenever the registered `SigningCertificateEnrollment` doesn't support this feature's own
 * extra methods (the `Null`/manual-CA defaults) - see `AcmeDrivenEnrollment`'s own doc comment.
 *
 * Concrete entity classes are supplied by the Mongo/SQL subclasses (`AcmeEnrollmentDriverJobMongo`/
 * `AcmeEnrollmentDriverJobSQL`), following the same generic pattern `ScanQueueJob`/`MailboxQuotaRecalcJob`
 * already use.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class AcmeEnrollmentDriverJob<MB extends Mailbox, K extends KeyVault> extends BackgroundService {
    protected abstract mailboxClass: any;
    protected abstract keyVaultClass: any;
    protected abstract auditLogClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private mailboxRepo?: RepoUtils<MB>;
    private keyVaultRepo?: RepoUtils<K>;

    @Inject("SigningCertificateEnrollment")
    private signingCertificateEnrollment?: AcmeDrivenEnrollment;

    @Config("mail:jobs:acme_enrollment_driver:schedule", "0 */5 * * * *")
    private scheduleExpr: string = "0 */5 * * * *";

    /** How many days before a signing key's `notAfter` the expiry check starts flagging it - S/MIME
     * Baseline Requirements cap lifetimes at 825 days and shrinking, so this defaults generously early
     * (30 days) to give a client's own renewal flow real lead time. */
    @Config("mail:jobs:acme_enrollment_driver:expiry_warning_days", 30)
    private expiryWarningDays: number = 30;

    // No key = the whole config object, the same decorator `ModelRoute.config`/`DomainVerificationJob.config`
    // itself use - needed by `recordAuditLog()`, which constructs a real `Event(config, ...)`.
    @Config()
    private config: any;

    @Logger
    private logger: any;

    public get schedule(): string | undefined {
        return this.scheduleExpr;
    }

    @Init
    public async init(): Promise<void> {
        this.mailboxRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.mailboxClass.name,
            args: [this.mailboxClass],
        });
        this.keyVaultRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.keyVaultClass.name,
            args: [this.keyVaultClass],
        });
    }

    public async start(): Promise<void> {
        // Nothing to do at startup beyond `init()` above; processing happens entirely in `run()`.
    }

    public stop(): Promise<void> | void {
        // Do nothing
    }

    public async run(): Promise<void> {
        await this.driveEnrollments();
        await this.flagExpiringSigningCerts();
    }

    private async driveEnrollments(): Promise<void> {
        if (
            typeof this.signingCertificateEnrollment?.listPendingEnrollments !== "function" ||
            typeof this.signingCertificateEnrollment.advanceEnrollment !== "function" ||
            typeof this.signingCertificateEnrollment.getIssuedMaterial !== "function" ||
            typeof this.signingCertificateEnrollment.markInstalled !== "function"
        ) {
            return;
        }

        const pending = await this.signingCertificateEnrollment.listPendingEnrollments();
        for (const { enrollmentId, identity, status } of pending) {
            try {
                if (status === "pending") {
                    await this.signingCertificateEnrollment.advanceEnrollment(enrollmentId);
                }
                const material = await this.signingCertificateEnrollment.getIssuedMaterial(enrollmentId);
                if (material && (await this.installCertificate(identity, material))) {
                    await this.signingCertificateEnrollment.markInstalled(enrollmentId);
                }
            } catch (err: any) {
                this.logger?.error(`AcmeEnrollmentDriverJob: failed to advance enrollment '${enrollmentId}' for '${identity}': ${err.message}`);
            }
        }
    }

    /**
     * Installs an issued certificate + its already-wrapped private key into `identity`'s mailbox - the
     * exact same `Mailbox.keys`/`KeyVault.wrappedKeys` shape `BaseKeyVaultRoute.enrollKey()`'s manual
     * `useType: "sign"` path installs, sharing its certificate-parsing/identity-binding logic
     * (`publicKeyFromCertificatePem()`) but not its `@Transactional()` two-entity write: unlike a
     * synchronous HTTP request, this is a scheduled, retriable background step, so a partial failure here
     * (mailbox updated, `KeyVault` write fails) self-heals on the next tick rather than needing true
     * atomicity - the fingerprint-collision check below makes a retry idempotent rather than duplicating
     * the key.
     *
     * Returns `true` once this identity's `KeyVault`/`Mailbox.keys` genuinely reflect the certificate
     * (including when it turns out to already be installed - the idempotent retry case) - only then does
     * the caller call `markInstalled()`. Returns `false` when nothing could be done yet (no mailbox found
     * for `identity`), so the caller leaves the enrollment exactly as-is for a later tick to retry, rather
     * than marking it installed when it demonstrably isn't.
     */
    private async installCertificate(
        identity: string,
        material: { certificate: string; wrappedKey: Omit<WrappedPrivateKey, "fingerprint" | "useType"> },
    ): Promise<boolean> {
        const [mailbox] = await this.mailboxRepo!.find({ primarySmtpAddress: identity, limit: 1 } as any, { ignoreACL: true, limit: 1 });
        if (!mailbox) {
            this.logger?.warn(`AcmeEnrollmentDriverJob: no mailbox found for '${identity}' - cannot install its issued certificate.`);
            return false;
        }

        const { publicKey, fingerprint } = publicKeyFromCertificatePem(material.certificate, "sign", mailbox.primarySmtpAddress);
        // Idempotent retry guard: a prior tick may have installed this exact certificate already and then
        // failed before reaching `markInstalled()` - re-adding it would duplicate the `Mailbox.keys` entry.
        if ((mailbox.keys ?? []).some((k) => k.fingerprint === fingerprint)) {
            return true;
        }

        await this.mailboxRepo!.update(
            { uid: mailbox.uid, version: (mailbox as any).version, keys: [...(mailbox.keys ?? []), publicKey] } as any,
            mailbox,
            { ignoreACL: true },
        );

        const [existingKeyVault] = await this.keyVaultRepo!.find({ mailboxUid: mailbox.uid, limit: 1 } as any, { ignoreACL: true, limit: 1 });
        const wrappedKey: WrappedPrivateKey = { ...material.wrappedKey, fingerprint, useType: "sign" };
        const keyVault: K = existingKeyVault
            ? await this.keyVaultRepo!.update(
                  { uid: existingKeyVault.uid, version: (existingKeyVault as any).version, wrappedKeys: [...existingKeyVault.wrappedKeys, wrappedKey] } as any,
                  existingKeyVault,
                  { ignoreACL: true },
              )
            : await this.keyVaultRepo!.create(new this.keyVaultClass({ mailboxUid: mailbox.uid, wrappedKeys: [wrappedKey] }), {
                  ignoreACL: true,
              });

        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, logger: this.logger },
            {
                action: AuditAction.KEY_VAULT_ENROLL,
                targetType: "KeyVault",
                targetUid: keyVault.uid,
                mailboxUid: mailbox.uid,
                details: { useType: "sign", fingerprint, automated: true },
            },
        );
        return true;
    }

    /**
     * Flags (audit-log entry only - detection, never a fresh CSR this server can't originate) any
     * mailbox whose newest non-revoked signing key is within `expiryWarningDays` of `notAfter` with
     * nothing newer already enrolled to supersede it.
     */
    private async flagExpiringSigningCerts(): Promise<void> {
        const threshold: number = Date.now() + this.expiryWarningDays * MS_PER_DAY;
        const mailboxes: MB[] = await this.mailboxRepo!.find({} as any, { ignoreACL: true });

        for (const mailbox of mailboxes) {
            const signingKeys: PublicKey[] = (mailbox.keys ?? []).filter((k) => k.useType === "sign" && !k.revokedAt);
            if (signingKeys.length === 0) {
                continue;
            }
            const newest: PublicKey = signingKeys.reduce((a, b) => (b.notAfter > a.notAfter ? b : a));
            if (newest.notAfter <= threshold) {
                await recordAuditLog(
                    this._objectFactory!,
                    this.auditLogClass,
                    { config: this.config, logger: this.logger },
                    {
                        action: AuditAction.SIGNING_CERT_EXPIRING,
                        targetType: "Mailbox",
                        targetUid: mailbox.uid,
                        mailboxUid: mailbox.uid,
                        details: { fingerprint: newest.fingerprint, notAfter: newest.notAfter },
                    },
                );
            }
        }
    }
}
