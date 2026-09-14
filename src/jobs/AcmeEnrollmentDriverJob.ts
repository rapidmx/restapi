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
     * Fetches every page of `repo.find(criteria)` (sorted by `uid` so pages are stable), not just
     * `RepoUtils.find()`'s default first 100 rows. `limit`/`page` are passed both in `options` (all the Mongo
     * backend reads) and baked into the criteria (all `ModelUtils.buildSearchQuerySQL` reads) - same pattern
     * as `MailboxQuotaRecalcJob.findAllPages()`.
     */
    private async forEachPage<T>(
        repo: RepoUtils<any>,
        criteria: Record<string, any>,
        handle: (row: T) => Promise<void>,
        pageSize: number = 100,
    ): Promise<void> {
        for (let page = 0; ; page++) {
            const batch: T[] = await repo.find({ ...criteria, sort: "uid", limit: pageSize, page } as any, {
                ignoreACL: true,
                limit: pageSize,
                page,
            });
            for (const row of batch) {
                await handle(row);
            }
            if (batch.length < pageSize) {
                break;
            }
        }
    }

    /**
     * Installs an issued certificate + its already-wrapped private key into `identity`'s mailbox - the
     * exact same `Mailbox.keys`/`KeyVault.wrappedKeys` shape `BaseKeyVaultRoute.enrollKey()`'s manual
     * `useType: "sign"` path installs, sharing its certificate-parsing/identity-binding logic
     * (`publicKeyFromCertificatePem()`) but not its `@Transactional()` two-entity write: unlike a
     * synchronous HTTP request, this is a scheduled, retriable background step, so a partial failure here
     * self-heals on the next tick rather than needing true atomicity.
     *
     * **Write order**: the `KeyVault` wrapped key is saved *before* the certificate is published on
     * `Mailbox.keys`. The reverse order could leave a published certificate whose private key the mailbox
     * doesn't hold (a crash between the two writes) - and since the retry guard previously skipped on
     * `Mailbox.keys` alone, that state was permanent. Each half is now checked independently by fingerprint
     * and only the missing half(s) written; the enrollment counts as already installed only when BOTH are
     * present.
     *
     * Returns `true` once this identity's `KeyVault`/`Mailbox.keys` genuinely reflect the certificate
     * (including when it turns out to already be installed - the idempotent retry case) - only then does
     * the caller call `markInstalled()`. Returns `false` when nothing could be done yet (no mailbox found
     * for `identity`), so the caller leaves the enrollment exactly as-is for a later tick to retry.
     */
    private async installCertificate(
        identity: string,
        material: { certificate: string; wrappedKey: Omit<WrappedPrivateKey, "fingerprint" | "useType"> },
    ): Promise<boolean> {
        const [found] = await this.mailboxRepo!.find({ primarySmtpAddress: identity, limit: 1 } as any, { ignoreACL: true, limit: 1 });
        if (!found) {
            this.logger?.warn(`AcmeEnrollmentDriverJob: no mailbox found for '${identity}' - cannot install its issued certificate.`);
            return false;
        }

        const { publicKey, fingerprint } = publicKeyFromCertificatePem(material.certificate, "sign", found.primarySmtpAddress);

        const [existingKeyVault] = await this.keyVaultRepo!.find({ mailboxUid: found.uid, limit: 1 } as any, { ignoreACL: true, limit: 1 });
        const vaultHasKey: boolean = (existingKeyVault?.wrappedKeys ?? []).some((k) => k.fingerprint === fingerprint);
        const mailboxHasKey: boolean = (found.keys ?? []).some((k) => k.fingerprint === fingerprint);
        if (vaultHasKey && mailboxHasKey) {
            return true;
        }

        let keyVaultUid: string = existingKeyVault?.uid ?? "";
        if (!vaultHasKey) {
            const wrappedKey: WrappedPrivateKey = { ...material.wrappedKey, fingerprint, useType: "sign" };
            // Re-fetched via `findOne()` before updating: `find()` returns un-hydrated documents on the Mongo
            // backend, for which `RepoUtils.update()` silently skips its optimistic-lock/version bump (see
            // `MailboxQuotaRecalcJob.recalcMailbox()`'s identical note).
            const current: K | undefined = existingKeyVault
                ? ((await this.keyVaultRepo!.findOne(existingKeyVault.uid, { ignoreACL: true })) ?? existingKeyVault)
                : undefined;
            const keyVault: K = current
                ? await this.keyVaultRepo!.update(
                      { uid: current.uid, version: (current as any).version, wrappedKeys: [...(current.wrappedKeys ?? []), wrappedKey] } as any,
                      current,
                      { ignoreACL: true },
                  )
                : await this.keyVaultRepo!.create(new this.keyVaultClass({ mailboxUid: found.uid, wrappedKeys: [wrappedKey] }), {
                      ignoreACL: true,
                  });
            keyVaultUid = keyVault.uid;
        }

        if (!mailboxHasKey) {
            const mailbox: MB = (await this.mailboxRepo!.findOne(found.uid, { ignoreACL: true })) ?? found;
            await this.mailboxRepo!.update(
                { uid: mailbox.uid, version: (mailbox as any).version, keys: [...(mailbox.keys ?? []), publicKey] } as any,
                mailbox,
                { ignoreACL: true },
            );
        }

        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, logger: this.logger },
            {
                action: AuditAction.KEY_VAULT_ENROLL,
                targetType: "KeyVault",
                targetUid: keyVaultUid,
                mailboxUid: found.uid,
                details: { useType: "sign", fingerprint, automated: true },
            },
        );
        return true;
    }

    /**
     * Flags (audit-log entry only - detection, never a fresh CSR this server can't originate) any
     * mailbox whose newest non-revoked signing key is within `expiryWarningDays` of `notAfter` with
     * nothing newer already enrolled to supersede it.
     *
     * Pages through every mailbox (not just the first 100), and records the entry **once per certificate**:
     * the flagged fingerprint is persisted on the mailbox's `KeyVault.expiryAuditedFingerprint`, and a run
     * that finds that fingerprint already recorded skips it. A newly enrolled certificate has a new
     * fingerprint, so it is flagged again once it nears its own expiry. A mailbox with a signing key but no
     * `KeyVault` row (not produced by any enrollment path - both write the vault) has nowhere to persist the
     * marker; it is logged and skipped rather than audited on every run.
     */
    private async flagExpiringSigningCerts(): Promise<void> {
        const threshold: number = Date.now() + this.expiryWarningDays * MS_PER_DAY;

        await this.forEachPage<MB>(this.mailboxRepo!, {}, async (mailbox) => {
            const signingKeys: PublicKey[] = (mailbox.keys ?? []).filter((k) => k.useType === "sign" && !k.revokedAt);
            if (signingKeys.length === 0) {
                return;
            }
            const newest: PublicKey = signingKeys.reduce((a, b) => (b.notAfter > a.notAfter ? b : a));
            if (newest.notAfter > threshold) {
                return;
            }
            try {
                const [found] = await this.keyVaultRepo!.find({ mailboxUid: mailbox.uid, limit: 1 } as any, { ignoreACL: true, limit: 1 });
                const keyVault: K | undefined = found ? ((await this.keyVaultRepo!.findOne(found.uid, { ignoreACL: true })) ?? found) : undefined;
                if (!keyVault) {
                    this.logger?.warn(`AcmeEnrollmentDriverJob: mailbox '${mailbox.uid}' has an expiring signing key but no KeyVault - skipping expiry audit.`);
                    return;
                }
                if (keyVault.expiryAuditedFingerprint === newest.fingerprint) {
                    return;
                }
                // Marker first: a failed audit write is only logged (`recordAuditLog()` never throws), which is
                // preferable to the reverse order, where a failing marker write would re-audit on every run.
                await this.keyVaultRepo!.update(
                    { uid: keyVault.uid, version: (keyVault as any).version, expiryAuditedFingerprint: newest.fingerprint } as any,
                    keyVault,
                    { ignoreACL: true },
                );
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
            } catch (err: any) {
                this.logger?.error(`AcmeEnrollmentDriverJob: failed to flag expiring signing certificate for mailbox '${mailbox.uid}': ${err.message}`);
            }
        });
    }
}
