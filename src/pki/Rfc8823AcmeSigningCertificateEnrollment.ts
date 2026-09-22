///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// See LocalX509CertificateAuthority.ts's identical note: `@peculiar/x509` requires `reflect-metadata`
// loaded before it is imported.
import "reflect-metadata";
// Node's `crypto` module (for `createHash`/`randomUUID`) is imported under its own name, NOT `crypto` -
// `x509.cryptoProvider.set()` below needs the *ambient global* `crypto` (WebCrypto, available with no
// import since Node 19), which is typed against `lib.dom` and subtly incompatible with `node:crypto`'s
// own `webcrypto` export - see `LocalX509CertificateAuthority.ts`'s identical note.
import * as nodeCrypto from "crypto";
import * as path from "path";
import * as x509 from "@peculiar/x509";
import * as acme from "acme-client";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import { BlobStore } from "../blob/BlobStore.js";
import { WrappedPrivateKey } from "../models/types.js";
import { ScanPipeline } from "../scan/ScanPipeline.js";
import { scanAndRelay } from "../util/MailSendUtils.js";
import { createFileExclusive, lockKeyForPath, readFileIfExists, updateJsonFile, withLock, writeFileAtomic } from "./FileStoreUtils.js";
import { AcmeMilestones, classifyOrderFailure, classifyTransientFailure, computeStages, FailureClass } from "./EnrollmentStages.js";
import {
    EnrollmentBinding,
    EnrollmentProgress,
    EnrollmentResult,
    EnrollmentSummary,
    SigningCertificateEnrollment,
} from "./SigningCertificateEnrollment.js";
const { Config, Inject, Logger } = ObjectDecorators;

x509.cryptoProvider.set(crypto);

/** Upper bound on `ensureAccount()`'s lost-race re-read loop - see its doc comment. */
const MAX_INIT_ATTEMPTS = 5;

/** How long `checkNow()` waits for the CA before answering with the current state (the check keeps running). */
const DEFAULT_CHECK_TIMEOUT_MS = 8_000;

/** How soon after one `checkNow()` the same enrollment refuses another (429). */
const DEFAULT_CHECK_MIN_INTERVAL_MS = 10_000;

/** The lowercased domain part of an email address (bare `local@domain`, or a trailing `<local@domain>`), or
 * `undefined` if `address` doesn't look like a single address at all. */
function addressDomain(address: string): string | undefined {
    const angle: RegExpExecArray | null = /<([^<>]*)>\s*$/.exec(address);
    const bare: string = (angle ? angle[1] : address).trim();
    const at: number = bare.lastIndexOf("@");
    if (at <= 0 || at === bare.length - 1 || /[\s<>,]/.test(bare)) {
        return undefined;
    }
    return bare.slice(at + 1).toLowerCase().replace(/\.$/, "");
}

/** The fields of `EnrollmentProgress` that come from the issued certificate itself (the first certificate of a PEM chain);
 * none when it can't be parsed. */
function certificateDetails(pem: string | undefined): Pick<EnrollmentProgress, "notAfter" | "serialNumber" | "issuer" | "subject"> {
    try {
        const certificate: x509.X509Certificate = new x509.X509Certificate(pem ?? "");
        return {
            notAfter: certificate.notAfter.toISOString(),
            serialNumber: certificate.serialNumber,
            issuer: certificate.issuer,
            subject: certificate.subject,
        };
    } catch {
        return {};
    }
}

/** One in-progress RFC 8823 enrollment, from `startEnrollment()` through to a downloaded certificate.
 * Everything needed to resume across a process restart lives here - see `loadStore()`/`updateStore()`. */
interface PendingEnrollment {
    identity: string;
    csr: string;
    orderUrl: string;
    /** The order's `finalize` URL - `finalizeOrder()` needs this in addition to `orderUrl` itself (see
     * `advanceEnrollment()`), and unlike `orderUrl`/`challengeUrl` it isn't derivable from anything else
     * this record already keeps. */
    orderFinalizeUrl: string;
    authorizationUrl: string;
    challengeUrl: string;
    /** The `from` address the CA's own challenge email will arrive from - `recordChallengeToken()`'s
     * caller (the inbound correlator, a later piece of this feature) uses this to recognize which
     * pending enrollment an inbound message belongs to. */
    challengeFrom: string;
    /** "token-part2" - the half of the RFC 8823 token this server already knows from the challenge
     * object itself, before the CA's challenge email (carrying "token-part1") ever arrives. */
    tokenPart2: string;
    status: "pending" | "issued" | "failed";
    /** The client's own already-wrapped private key for the CSR's key pair, submitted upfront alongside
     * the CSR (`attachWrappedKey()`) - held here until the certificate is issued, so the driver job
     * (this feature's own follow-on piece) can auto-install the finished `PublicKey`/`WrappedPrivateKey`
     * pair into the mailbox's `KeyVault` with no further client action, the same E2E boundary
     * `BaseKeyVaultRoute.enrollKey()` already keeps (this server never sees an unwrapped private key). */
    wrappedKey?: Omit<WrappedPrivateKey, "fingerprint" | "useType">;
    /** The mailbox that attached `wrappedKey` - `BaseKeyVaultRoute` binds enrollment ids to it, and the driver job
     * installs only into it. */
    mailboxUid?: string;
    /** `KeyVault.masterKeyGeneration` when `wrappedKey` was attached: the key is sealed under that master key, and the
     * driver job refuses to install it once the vault has rotated past it. */
    masterKeyGeneration?: number;
    tokenPart1?: string;
    /** The address the reply email must be sent `To:` - the challenge email's own `Reply-To` header,
     * falling back to its `From` (see `recordChallengeToken()`'s own doc comment). */
    replyTo?: string;
    challengeMessageId?: string;
    challengeSubject?: string;
    /** base64url(SHA-256(keyAuthorization)) - the exact value RFC 8823's reply email body carries.
     * Computed by `recordChallengeToken()` (recomputed if it is re-recorded before the reply is sent); a later piece of this feature sends the reply email
     * and drives `completeChallenge()`/finalize once this is set. */
    digest?: string;
    /** Set once the reply email has actually been sent and `completeChallenge()` called - `advanceEnrollment()`'s
     * cue to stop resending the reply and start polling the order/authorization instead. */
    replySentAt?: string;
    /** Set once `AcmeEnrollmentDriverJob` has successfully installed the issued certificate into the
     * mailbox's `KeyVault` - `listPendingEnrollments()` keeps returning an `"issued"` enrollment until
     * this is set, so a failed install attempt (network blip, a since-deleted mailbox, etc.) gets retried
     * on the next tick rather than being silently lost the moment `status` leaves `"pending"`. */
    installedAt?: string;
    certificate?: string;
    error?: string;
    createdAt: string;
    /** Every field below is the enrollment's progress record (`describeProgress()`): stage timestamps that survive a
     * restart, and what the last check saw. All optional - a record from before they existed reads correctly from the
     * fields above (`computeStages()`). */
    /** When the record last changed. */
    updatedAt?: string;
    /** When the CA's verification e-mail was received and its token recorded. */
    challengeReceivedAt?: string;
    /** When the order was finalized with the CSR. */
    finalizedAt?: string;
    /** When the certificate was downloaded. */
    issuedAt?: string;
    /** When the enrollment failed (or was cancelled). */
    failedAt?: string;
    /** Why it failed (`FailureClass.errorCode`) and whether a new request could succeed. */
    errorCode?: string;
    retryable?: boolean;
    /** The order's `expires` as the CA reported it (ISO 8601): past it, a request still waiting on the challenge is dead. */
    orderExpires?: string;
    /** The last order status the CA reported. */
    orderStatus?: string;
    /** When this enrollment was last checked (background job tick or check-now). */
    lastCheckedAt?: string;
    /** When check-now last ran - what the per-enrollment rate limit reads, so it holds across replicas and restarts. */
    lastForcedCheckAt?: string;
    /** The last attempt's failure while the enrollment is still pending (cleared by the next step that succeeds). */
    lastError?: { code: string; message: string; at: string };
}

/**
 * Real RFC 8823 `email-reply-00` ACME automation - `specs/end-to-end_encryption.md`'s "MUST be
 * automated" requirement for public signing-certificate enrollment, replacing
 * `ManualSigningCertificateEnrollment`'s admin-pastes-a-CSR-into-a-portal flow with a real ACME
 * client talking to any RFC 8823-compliant CA (`directoryUrl` is configurable, not hardcoded to one
 * vendor - CASTLE Platform's `https://acme.castle.cloud/acme/directory` is the documented default,
 * matching this codebase's existing "avoid vendor lock-in" precedent for `OpenBaoPkiCertificateAuthority`
 * vs. the rejected paid-CA option, see `EncryptionCertificateAuthority`'s own doc comment history).
 *
 * Built on the `acme-client` npm package for the generic RFC 8555 plumbing (account key management,
 * JWS request signing, nonce/replay handling, directory discovery, order finalize + certificate
 * download) - all real, security-sensitive protocol code with no RFC 8823-specific logic of its own,
 * better reused than hand-rolled. Driven via its low-level/manual API only (`createOrder()`,
 * `getAuthorizations()`, `completeChallenge()`, `finalizeOrder()`, `getCertificate()`) - never its
 * `auto()` helper, which only recognizes `http-01`/`dns-01` and has no notion of `email-reply-00`.
 *
 * **This class alone does not complete an enrollment.** RFC 8823's `email-reply-00` challenge
 * requires receiving an inbound challenge email (correlated against a pending enrollment by a
 * separate piece of this feature, since that's this codebase's mail-ingest pipeline's job, not this
 * class's) and sending a reply email (also a separate piece, since composing/sending mail is
 * `MailSendUtils`'s job) before the CA will ever mark the challenge valid. This class owns exactly
 * the ACME-protocol half of the flow:
 * - `startEnrollment()`: creates/reuses this deployment's one persisted ACME account, opens an order
 * for the `email` identifier, and extracts the `email-reply-00` challenge's `from`/token-part2.
 * - `recordChallengeToken()`: once the inbound correlator recognizes the CA's challenge email and
 * extracts token-part1 from its `Subject`, computes and persists the exact digest the reply email's
 * body must carry.
 * - `checkStatus()`: a pure read of the persisted enrollment's current state - it does not itself
 * drive `completeChallenge()`/poll/finalize (a background job, once the reply has actually been sent,
 * does that - see this feature's own follow-on pieces).
 *
 * State (the ACME account key/URL, and every pending enrollment) is persisted as small local JSON/PEM
 * files - the same "own a small piece of local state on disk" shape `LocalX509CertificateAuthority`'s
 * CA key and `ManualSigningCertificateEnrollment`'s enrollment store already use in this codebase.
 *
 * @author Jean-Philippe Steinmetz
 */
export class Rfc8823AcmeSigningCertificateEnrollment implements SigningCertificateEnrollment {
    public readonly name: string = "rfc8823-acme";

    @Config("mail:pki:rfc8823:directory_url", "https://acme.castle.cloud/acme/directory")
    private directoryUrl: string = "https://acme.castle.cloud/acme/directory";

    @Config("mail:pki:rfc8823:contact_email")
    private contactEmail?: string;

    @Config("mail:pki:rfc8823:store_dir", "/var/lib/rapidmx/pki/rfc8823")
    private storeDir: string = "/var/lib/rapidmx/pki/rfc8823";

    /** How often `AcmeEnrollmentDriverJob` checks a pending enrollment (seconds) - only what `EnrollmentProgress.nextCheckAt` is
     * computed from, so keep it equal to that job's own schedule (`mail:jobs:acme_enrollment_driver:schedule`, every 5 minutes). */
    @Config("mail:pki:rfc8823:poll_interval_seconds", 300)
    private pollIntervalSeconds: number = 300;

    /** How long a request may stay pending when the CA did not say when its order expires (`order.expires`). */
    @Config("mail:pki:rfc8823:max_pending_hours", 168)
    private maxPendingHours: number = 168;

    @Logger
    private logger: any;

    /** Same DI tokens `ScanQueueJob`/`BaseMessageRoute` already consume for `MailSendUtils.scanAndRelay()` -
     * needed here to actually send the RFC 8823 reply email `advanceEnrollment()` composes. */
    @Inject("MailTransport")
    private mailTransport?: any;

    @Inject(ScanPipeline)
    private scanPipeline?: ScanPipeline;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    private accountKeyPath(): string {
        return path.join(this.storeDir, "account.key.pem");
    }

    private accountUrlPath(): string {
        return path.join(this.storeDir, "account.url");
    }

    private enrollmentsPath(): string {
        return path.join(this.storeDir, "enrollments.json");
    }

    /** Overridable seam for tests - constructs the real `acme-client` `Client` in production, a fake
     * in tests (no real network calls, no dependency on a live CA). */
    protected createClient(opts: acme.ClientOptions): acme.Client {
        return new acme.Client(opts);
    }

    /** Loads this deployment's one persisted ACME account (key + account URL), registering it on first use.
     * Idempotent and safe to call before every operation - once minted, the account key is stable for the
     * deployment's lifetime, the same reasoning `LocalX509CertificateAuthority.ensureCa()` already documents
     * for its own root key.
     *
     * First-run initialization is crash- and race-safe, mirroring `ensureCa()`:
     * - Serialized within this process (`withLock()` on the key path).
     * - The account key is persisted crash-atomically and create-only (`createFileExclusive()`) *before* the
     * account is registered, so every later attempt - after a crash, a failed `newAccount` request, or a lost
     * race with another process - reuses that same key rather than minting another.
     * - "Key present, account URL missing" is recovered by calling `createAccount()` again with the existing
     * key: RFC 8555 §7.3.1 makes `newAccount` idempotent per key (the CA returns the already-registered
     * account with HTTP 200, which `acme-client` handles), so this never creates a second account.
     * - Bounded: gives up with an error after `MAX_INIT_ATTEMPTS` lost races rather than looping forever; a
     * network failure from `createAccount()` propagates to the caller (the next call simply retries). */
    private async ensureAccount(): Promise<acme.Client> {
        return withLock(lockKeyForPath(this.accountKeyPath()), async () => {
            for (let attempt = 0; attempt < MAX_INIT_ATTEMPTS; attempt++) {
                const accountKey: string | undefined = await readFileIfExists(this.accountKeyPath());
                if (accountKey === undefined) {
                    const newKey: Buffer = await acme.crypto.createPrivateEcdsaKey("P-256");
                    await createFileExclusive(this.accountKeyPath(), newKey, 0o600, 0o700);
                    // Either way, loop back and read whichever key is now on disk (ours, or a concurrent winner's).
                    continue;
                }

                const accountUrl: string | undefined = (await readFileIfExists(this.accountUrlPath()))?.trim();
                if (accountUrl) {
                    return this.createClient({ directoryUrl: this.directoryUrl, accountKey, accountUrl });
                }

                const client: acme.Client = this.createClient({ directoryUrl: this.directoryUrl, accountKey });
                await client.createAccount({
                    termsOfServiceAgreed: true,
                    contact: this.contactEmail ? [`mailto:${this.contactEmail}`] : undefined,
                });
                // A present-but-blank URL file can only be a torn write from before these writes were atomic - safe
                // to replace outright, since the account URL is fully determined by the key.
                let persisted: boolean = true;
                if (accountUrl === undefined) {
                    persisted = await createFileExclusive(this.accountUrlPath(), client.getAccountUrl(), 0o600, 0o700);
                } else {
                    await writeFileAtomic(this.accountUrlPath(), client.getAccountUrl(), 0o600, 0o700);
                }
                if (persisted) {
                    this.logger?.info(`Rfc8823AcmeSigningCertificateEnrollment: registered ACME account at '${this.directoryUrl}'.`);
                    return client;
                }
                // Another process persisted the account URL first - loop back and use theirs.
            }
            throw new Error(
                `Rfc8823AcmeSigningCertificateEnrollment: could not initialize the ACME account in '${this.storeDir}' after ${MAX_INIT_ATTEMPTS} attempts.`,
            );
        });
    }

    private async loadStore(): Promise<Record<string, PendingEnrollment>> {
        const raw: string | undefined = await readFileIfExists(this.enrollmentsPath());
        return raw === undefined ? {} : JSON.parse(raw);
    }

    /** Locked re-read -> modify -> atomic write of the enrollment store (`FileStoreUtils.updateJsonFile()`), so
     * concurrent mutations in this process never drop one another's update and a crash mid-write never
     * truncates the store. Keep `mutate` short - it runs while holding the store-wide lock; slow network work
     * belongs outside it (see `withEnrollmentLock()`). */
    private async updateStore<T>(mutate: (store: Record<string, PendingEnrollment>) => Promise<T> | T): Promise<T> {
        return updateJsonFile(this.enrollmentsPath(), 0o600, mutate, 0o700);
    }

    /** Serializes the multi-step, network-bound operations on one enrollment (`recordChallengeToken()`,
     * `advanceEnrollment()`) within this process - so a challenge token can't be replaced while its reply is
     * mid-send, and two overlapping driver ticks can't both send the reply - without holding the store-wide
     * lock across network calls. Lock ordering: this lock may be held while taking the store lock (via
     * `updateStore()`) or the account lock (`ensureAccount()`), never the reverse. */
    private async withEnrollmentLock<T>(enrollmentId: string, fn: () => Promise<T>): Promise<T> {
        return withLock(`${lockKeyForPath(this.enrollmentsPath())}#enrollment:${enrollmentId}`, fn);
    }

    private async requireEnrollment(store: Record<string, PendingEnrollment>, enrollmentId: string): Promise<PendingEnrollment> {
        const enrollment: PendingEnrollment | undefined = store[enrollmentId];
        if (!enrollment) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, `No enrollment found with id '${enrollmentId}'.`);
        }
        return enrollment;
    }

    public async startEnrollment(identity: string, csr: string): Promise<{ enrollmentId: string }> {
        let parsedCsr: x509.Pkcs10CertificateRequest;
        try {
            parsedCsr = new x509.Pkcs10CertificateRequest(csr);
        } catch {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The provided CSR could not be parsed.");
        }
        if (!(await parsedCsr.verify())) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The provided CSR's self-signature does not verify.");
        }

        const client: acme.Client = await this.ensureAccount();
        const order: acme.Order = await client.createOrder({ identifiers: [{ type: "email", value: identity }] });
        const [authorization] = await client.getAuthorizations(order);
        // `email-reply-00` isn't part of `acme-client`'s own `rfc8555.Challenge` union (it only models
        // `http-01`/`dns-01`) - the object is real at runtime (any RFC 8823-compliant CA returns it),
        // just not typed by this dependency, hence the cast.
        const challenge: { type: string; url: string; from?: string; token?: string } | undefined = (
            authorization.challenges as unknown as Array<{ type: string; url: string; from?: string; token?: string }>
        ).find((c) => c.type === "email-reply-00");
        if (!challenge?.from || !challenge.token) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The certificate authority did not offer an email-reply-00 challenge.");
        }

        const enrollmentId: string = crypto.randomUUID();
        const { from: challengeFrom, token: tokenPart2 } = challenge;
        await this.updateStore((store) => {
            store[enrollmentId] = {
                identity,
                csr,
                orderUrl: order.url,
                orderFinalizeUrl: order.finalize,
                authorizationUrl: authorization.url,
                challengeUrl: challenge.url,
                challengeFrom,
                tokenPart2,
                status: "pending",
                createdAt: new Date().toISOString(),
                ...(order.expires ? { orderExpires: order.expires } : {}),
            };
        });

        this.logger?.info(`Rfc8823AcmeSigningCertificateEnrollment: started enrollment '${enrollmentId}' for '${identity}'.`);
        return { enrollmentId };
    }

    /**
     * Finds the pending enrollment (if any) whose RFC 8823 challenge reply hasn't been sent yet for
     * `identity`, whose challenge is expected to arrive `from` that exact address - the inbound
     * mail-ingest pipeline's own correlator (`ScanQueueJob`) calls this for every candidate message
     * (one whose `Auto-Submitted`/`Subject` shape already looks like an ACME challenge) before ever
     * treating it as CA plumbing, since nothing in the challenge email itself carries this server's
     * own `enrollmentId` - only a real, still-outstanding enrollment for this exact (identity, from)
     * pair should ever be matched. Comparison is case-insensitive (email addresses' domain part is
     * always case-insensitive, and the local part is, in practice, treated the same way by virtually
     * every real mailbox).
     *
     * An enrollment that has already recorded a token-part1 keeps matching until its reply has actually
     * been sent (`replySentAt`) - so a spoofed early lookalike can't permanently claim the enrollment; the
     * genuine challenge email arriving later replaces it (see `recordChallengeToken()`).
     *
     * Returns `undefined` - never throws - when nothing matches, so a spoofed or stale
     * lookalike message safely falls through to normal delivery instead of being silently dropped.
     */
    public async findPendingEnrollmentId(identity: string, from: string): Promise<string | undefined> {
        const store: Record<string, PendingEnrollment> = await this.loadStore();
        const normalizedIdentity: string = identity.toLowerCase();
        const normalizedFrom: string = from.toLowerCase();
        for (const [enrollmentId, enrollment] of Object.entries(store)) {
            if (
                enrollment.status === "pending" &&
                enrollment.replySentAt === undefined &&
                enrollment.identity.toLowerCase() === normalizedIdentity &&
                enrollment.challengeFrom.toLowerCase() === normalizedFrom
            ) {
                return enrollmentId;
            }
        }
        return undefined;
    }

    /**
     * Records the RFC 8823 challenge email's own contribution - token-part1, plus the headers the
     * reply needs (`replyTo`/`messageId`/`subject`) - once the inbound correlator recognizes it, and
     * computes the digest the reply email's body must carry.
     *
     * Per RFC 8823 §3, `keyAuthorization = token + "." + accountKey.thumbprint` where `token =
     * token-part1 + token-part2`, and the reply carries `base64url(SHA-256(keyAuthorization))`.
     * `acme-client`'s own `getChallengeKeyAuthorization()` has no `email-reply-00` case (it throws for
     * any type it doesn't recognize - confirmed by reading its source), but its `http-01` case
     * computes exactly the un-hashed `token + "." + thumbprint` this RFC also needs (unlike `dns-01`,
     * which hashes an extra time for a DNS TXT record) - so a challenge object with `type` spoofed to
     * `"http-01"` and `token` set to the concatenated token-part1+part2 gets the right formula out of
     * a dependency that has no native notion of this RFC's own challenge type, without reaching into
     * its private internals.
     *
     * **Re-recordable until the reply is sent**: a later call replaces an earlier recorded token-part1/
     * headers/digest as long as the reply email hasn't been sent yet - so a spoofed early challenge email
     * (which can never yield a digest the CA accepts) can't permanently poison the enrollment; the genuine
     * one arriving afterward simply wins. Once `replySentAt` is set (or the enrollment is no longer
     * `"pending"`) this is a silent no-op, so a late duplicate can't change the digest the CA is already
     * validating.
     *
     * **Reply-To must be within the CA's domain**: `replyTo`'s domain must equal the domain of the
     * enrollment's expected challenge `from` address, or be a subdomain of it - otherwise the reply (whose
     * digest proves control of `identity`) could be redirected to a mailbox of the sender's choosing.
     *
     * @param enrollmentId An identifier previously returned by `startEnrollment()`.
     * @param replyTo A single address (`local@domain`, or `Name <local@domain>`).
     * @throws If `enrollmentId` is not recognized, or `replyTo` is not a single address within the CA's
     * domain - nothing is recorded in either case.
     */
    public async recordChallengeToken(
        enrollmentId: string,
        tokenPart1: string,
        replyTo: string,
        messageId: string,
        subject: string,
    ): Promise<void> {
        await this.withEnrollmentLock(enrollmentId, async () => {
            const enrollment: PendingEnrollment = await this.requireEnrollment(await this.loadStore(), enrollmentId);

            const caDomain: string | undefined = addressDomain(enrollment.challengeFrom);
            const replyToDomain: string | undefined = addressDomain(replyTo);
            if (!caDomain || !replyToDomain || (replyToDomain !== caDomain && !replyToDomain.endsWith(`.${caDomain}`))) {
                throw new ApiError(
                    ApiErrors.INVALID_REQUEST,
                    400,
                    `The challenge email's reply-to address is not within the certificate authority's domain '${caDomain ?? ""}'.`,
                );
            }
            if (enrollment.status !== "pending" || enrollment.replySentAt !== undefined) {
                return;
            }

            const client: acme.Client = await this.ensureAccount();
            // `acme-client`'s own `rfc8555.Challenge` type (not part of this package's public exports,
            // hence the local `FakeHttpChallenge` shape rather than importing it) only models
            // `http-01`/`dns-01`/`tls-alpn-01` - see this method's own doc comment on why `type` is
            // deliberately spoofed as `"http-01"` so `getChallengeKeyAuthorization()` applies that case's
            // un-hashed `token + "." + thumbprint` formula, exactly what RFC 8823 needs, rather than
            // throwing on an `email-reply-00` type it has no case for.
            const fakeHttpChallenge = {
                type: "http-01" as const,
                url: enrollment.challengeUrl,
                status: "pending" as const,
                token: tokenPart1 + enrollment.tokenPart2,
            };
            const keyAuthorization: string = await client.getChallengeKeyAuthorization(fakeHttpChallenge);
            const digest: string = nodeCrypto.createHash("sha256").update(keyAuthorization).digest("base64url");

            await this.mutateEnrollment(enrollmentId, (current) => {
                current.tokenPart1 = tokenPart1;
                current.replyTo = replyTo;
                current.challengeMessageId = messageId;
                current.challengeSubject = subject;
                current.digest = digest;
                current.challengeReceivedAt = new Date().toISOString();
            });
        });
    }

    public async checkStatus(enrollmentId: string): Promise<EnrollmentResult> {
        const store: Record<string, PendingEnrollment> = await this.loadStore();
        const enrollment: PendingEnrollment = await this.requireEnrollment(store, enrollmentId);
        return { status: enrollment.status, certificate: enrollment.certificate, error: enrollment.error };
    }

    /**
     * Records the client's already-wrapped private key for this enrollment's CSR, submitted upfront by
     * the REST endpoint that calls `startEnrollment()` - see `PendingEnrollment.wrappedKey`'s own doc
     * comment on why this is a separate call rather than a third `startEnrollment()` parameter (this
     * data is specific to the automated flow's own auto-install step, not something
     * `ManualSigningCertificateEnrollment`/`NullSigningCertificateEnrollment` have any use for, so it
     * stays off the shared `SigningCertificateEnrollment` interface entirely).
     *
     * @throws If `enrollmentId` is not recognized.
     */
    //
    // `binding` records the mailbox and its vault's master-key generation alongside the key - see
    // `PendingEnrollment.mailboxUid`/`masterKeyGeneration`.
    public async attachWrappedKey(
        enrollmentId: string,
        wrappedKey: Omit<WrappedPrivateKey, "fingerprint" | "useType">,
        binding?: { mailboxUid: string; masterKeyGeneration: number },
    ): Promise<void> {
        await this.updateStore(async (store) => {
            const enrollment: PendingEnrollment = await this.requireEnrollment(store, enrollmentId);
            enrollment.wrappedKey = wrappedKey;
            if (binding) {
                enrollment.mailboxUid = binding.mailboxUid;
                enrollment.masterKeyGeneration = binding.masterKeyGeneration;
            }
        });
    }

    /** See `SigningCertificateEnrollment.describeEnrollment()`. */
    public async describeEnrollment(enrollmentId: string): Promise<EnrollmentBinding> {
        const enrollment: PendingEnrollment = await this.requireEnrollment(await this.loadStore(), enrollmentId);
        return { identity: enrollment.identity, mailboxUid: enrollment.mailboxUid };
    }

    /** See `SigningCertificateEnrollment.cancelEnrollment()` - a pending, or issued but not installed, enrollment is
     * marked failed, so `listPendingEnrollments()` drops it and nothing is installed from it. */
    public async cancelEnrollment(enrollmentId: string, reason: string): Promise<void> {
        await this.withEnrollmentLock(enrollmentId, async () => {
            await this.mutateEnrollment(enrollmentId, (enrollment) => {
                if (enrollment.status === "pending" || (enrollment.status === "issued" && enrollment.installedAt === undefined)) {
                    this.markFailed(enrollment, reason, { errorCode: "cancelled", retryable: true });
                }
            });
        });
    }

    /**
     * Every enrollment a driver job still has work to do for: either `status === "pending"` (needs
     * `advanceEnrollment()`) or `status === "issued"` with no `installedAt` yet (needs installing) - see
     * `AcmeEnrollmentDriverJob`, this feature's own follow-on piece. Keeping both in one list means a
     * failed install attempt (network blip, a since-deleted mailbox) naturally gets retried on the next
     * tick rather than being lost the moment `status` leaves `"pending"`. Never includes the CSR/wrapped-
     * key contents themselves - a caller that needs those re-reads via `checkStatus()`/`getIssuedMaterial()`.
     */
    public async listPendingEnrollments(): Promise<
        Array<{ enrollmentId: string; identity: string; status: PendingEnrollment["status"]; mailboxUid?: string; hasWrappedKey: boolean }>
    > {
        const store: Record<string, PendingEnrollment> = await this.loadStore();
        return Object.entries(store)
            .filter(([, enrollment]) => enrollment.status === "pending" || (enrollment.status === "issued" && enrollment.installedAt === undefined))
            .map(([enrollmentId, enrollment]) => ({
                enrollmentId,
                identity: enrollment.identity,
                status: enrollment.status,
                mailboxUid: enrollment.mailboxUid,
                hasWrappedKey: !!enrollment.wrappedKey,
            }));
    }

    /**
     * Records that `AcmeEnrollmentDriverJob` has successfully installed this `"issued"` enrollment's
     * certificate into the mailbox's `KeyVault` - `listPendingEnrollments()` stops returning it afterward.
     *
     * @throws If `enrollmentId` is not recognized.
     */
    public async markInstalled(enrollmentId: string): Promise<void> {
        await this.mutateEnrollment(enrollmentId, (enrollment) => {
            enrollment.installedAt = new Date().toISOString();
        });
    }

    /**
     * Returns the exact `{publicKeyPem: certificate, wrappedKey}` pair `AcmeEnrollmentDriverJob` needs to
     * auto-install an `"issued"` enrollment - `undefined` if the enrollment isn't `"issued"` yet, has no
     * certificate on file, or never had a `wrappedKey` attached (an enrollment started before this
     * feature existed, or through a caller that never called `attachWrappedKey()` - install falls back
     * to the existing manual `enrollKey()` path for those, same as before this feature existed).
     */
    public async getIssuedMaterial(
        enrollmentId: string,
    ): Promise<
        | { certificate: string; wrappedKey: Omit<WrappedPrivateKey, "fingerprint" | "useType">; mailboxUid?: string; masterKeyGeneration?: number }
        | undefined
    > {
        const store: Record<string, PendingEnrollment> = await this.loadStore();
        const enrollment: PendingEnrollment = await this.requireEnrollment(store, enrollmentId);
        if (enrollment.status !== "issued" || !enrollment.certificate || !enrollment.wrappedKey) {
            return undefined;
        }
        return {
            certificate: enrollment.certificate,
            wrappedKey: enrollment.wrappedKey,
            mailboxUid: enrollment.mailboxUid,
            masterKeyGeneration: enrollment.masterKeyGeneration,
        };
    }

    /**
     * Advances `enrollmentId` by exactly one state-machine step, then returns - never blocks waiting on
     * the CA (unlike `acme-client`'s own `waitForValidStatus()`, deliberately not used here), and is
     * always safe to call again later (a background driver job, this feature's own follow-on piece, is
     * expected to call this repeatedly for every non-terminal enrollment until it reaches `"issued"`/
     * `"failed"`). A no-op (returns immediately) when there's nothing yet to do:
     * - `status !== "pending"` - already terminal.
     * - `digest === undefined` - still waiting on `recordChallengeToken()` (the challenge email hasn't
     * arrived/correlated yet).
     *
     * The one step taken, in order:
     * 1. `replySentAt === undefined`: compose and send the RFC 8823 reply email (`MailComposer` +
     * `scanAndRelay()`, matching this codebase's own established outbound-mail pattern), then notify
     * the CA via `completeChallenge()` - both must succeed together, so `replySentAt` is only
     * persisted afterward, and a failure here leaves the enrollment exactly as it was for a later
     * retry (never a reply sent with no corresponding `completeChallenge()` call, or vice versa).
     * 2. Otherwise, re-fetch the order (`getOrder()`, a plain single GET - not a retrying wait) and
     * branch on its `status`: `"invalid"` marks this enrollment `"failed"`; `"pending"`/`"processing"`
     * does nothing (still waiting on the CA); `"ready"` finalizes with the original CSR; `"valid"`
     * downloads the certificate and marks this enrollment `"issued"`.
     */
    public async advanceEnrollment(enrollmentId: string): Promise<void> {
        await this.advance(enrollmentId, false);
    }

    /**
     * `advanceEnrollment()`'s step, shared with `checkNow()`. Beyond what that method documents: a request whose CA order has
     * expired (`hasExpired()`) is failed rather than left pending forever; the check is recorded (`lastCheckedAt`); and an
     * error thrown mid-step (the CA unreachable, the reply not relayed) is recorded as the enrollment's `lastError` - still
     * pending, retried on the next tick - and rethrown, so the job logs it exactly as before. `peekOrder` (check-now only)
     * also asks the CA about the order while the challenge e-mail hasn't arrived, which is how a request the CA has already
     * given up on is noticed before the e-mail is ever due.
     */
    private async advance(enrollmentId: string, peekOrder: boolean): Promise<void> {
        await this.withEnrollmentLock(enrollmentId, async () => {
            const enrollment: PendingEnrollment = await this.requireEnrollment(await this.loadStore(), enrollmentId);
            if (enrollment.status !== "pending") {
                return;
            }
            if (this.hasExpired(enrollment, Date.now())) {
                await this.mutateEnrollment(enrollmentId, (current) => {
                    this.markFailed(current, "The certificate authority did not finish validating this request before it expired. Start a new request.", {
                        errorCode: "order-expired",
                        retryable: true,
                    });
                });
                return;
            }

            await this.mutateEnrollment(enrollmentId, (current) => {
                current.lastCheckedAt = new Date().toISOString();
            });
            if (enrollment.digest === undefined && !peekOrder) {
                return;
            }

            let phase: "reply" | "ca" = "ca";
            try {
                const client: acme.Client = await this.ensureAccount();
                if (enrollment.digest === undefined) {
                    // Waiting for the CA's verification e-mail: only an order the CA already marked invalid changes anything.
                    const order: acme.Order = await client.getOrder({ url: enrollment.orderUrl } as any);
                    await this.recordOrderStatus(enrollmentId, order);
                } else if (enrollment.replySentAt === undefined) {
                    phase = "reply";
                    await this.sendChallengeReply(enrollment);
                    phase = "ca";
                    await client.completeChallenge({ url: enrollment.challengeUrl, status: "pending" } as any);
                    await this.mutateEnrollment(enrollmentId, (current) => {
                        current.replySentAt = new Date().toISOString();
                    });
                } else {
                    await this.advanceOrder(enrollmentId, enrollment, client);
                }
            } catch (err: any) {
                await this.recordTransientFailure(enrollmentId, err, phase);
                throw err;
            }
            if (enrollment.lastError) {
                await this.mutateEnrollment(enrollmentId, (current) => {
                    delete current.lastError;
                });
            }
        });
    }

    /** Re-fetches the order (`getOrder()`, one plain GET) and takes the step its status calls for: `"ready"` finalizes with the
     * original CSR, `"valid"` downloads the certificate, `"invalid"` fails the enrollment, anything else waits. */
    private async advanceOrder(enrollmentId: string, enrollment: PendingEnrollment, client: acme.Client): Promise<void> {
        const order: acme.Order = await client.getOrder({ url: enrollment.orderUrl } as any);
        if (order.status === "ready") {
            await client.finalizeOrder({ url: enrollment.orderUrl, finalize: enrollment.orderFinalizeUrl } as any, enrollment.csr);
            // Finalizing transitions the order to "processing" server-side - the next call to this method re-fetches and
            // observes that.
            await this.mutateEnrollment(enrollmentId, (current) => {
                current.finalizedAt = new Date().toISOString();
                current.orderStatus = "ready";
            });
        } else if (order.status === "valid") {
            const certificate: string = await client.getCertificate({ url: enrollment.orderUrl, status: "valid" } as any);
            await this.mutateEnrollment(enrollmentId, (current) => {
                const now: string = new Date().toISOString();
                current.status = "issued";
                current.certificate = certificate;
                current.issuedAt = now;
                current.finalizedAt ??= now;
                current.orderStatus = "valid";
            });
        } else {
            // "pending"/"processing": still waiting on the CA - nothing to do until the next call ("invalid" fails it).
            await this.recordOrderStatus(enrollmentId, order);
        }
    }

    /** Stores what the CA said about the order (its status and expiry), failing the enrollment if it is `invalid`. */
    private async recordOrderStatus(enrollmentId: string, order: acme.Order): Promise<void> {
        await this.mutateEnrollment(enrollmentId, (current) => {
            current.orderStatus = order.status;
            if (order.expires) {
                current.orderExpires = order.expires;
            }
            if (order.status === "invalid") {
                this.markFailed(current, order.error ? JSON.stringify(order.error) : "The certificate authority marked this order invalid.", classifyOrderFailure(order.error));
            }
        });
    }

    /** Persists the failure of an attempt on a still-pending enrollment (`lastError`), best-effort. */
    private async recordTransientFailure(enrollmentId: string, err: any, phase: "reply" | "ca"): Promise<void> {
        try {
            const failure: FailureClass = classifyTransientFailure(err, phase);
            await this.mutateEnrollment(enrollmentId, (current) => {
                current.lastError = { code: failure.errorCode, message: String(err?.message ?? err), at: new Date().toISOString() };
            });
        } catch (writeErr: any) {
            this.logger?.warn(`Rfc8823AcmeSigningCertificateEnrollment: could not record the failure of enrollment '${enrollmentId}': ${writeErr?.message}`);
        }
    }

    /** Marks `enrollment` failed - the one place every failure (CA refusal, expiry, cancellation) is recorded. */
    private markFailed(enrollment: PendingEnrollment, reason: string, failure: FailureClass): void {
        enrollment.status = "failed";
        enrollment.error = reason;
        enrollment.errorCode = failure.errorCode;
        enrollment.retryable = failure.retryable;
        enrollment.failedAt = new Date().toISOString();
    }

    /** Whether a request still waiting on the CA has outlived its ACME order: the CA's own `expires`, else `maxPendingHours` from
     * the request. An order the CA is already finalizing is not expired - it is the CA's to finish. */
    private hasExpired(enrollment: PendingEnrollment, now: number): boolean {
        if (enrollment.finalizedAt !== undefined || enrollment.orderStatus === "ready" || enrollment.orderStatus === "processing") {
            return false;
        }
        const limit: number = enrollment.orderExpires ? Date.parse(enrollment.orderExpires) : Date.parse(enrollment.createdAt) + this.maxPendingHours * 3_600_000;
        return limit <= now;
    }

    /** Locked re-read -> `mutate` -> write of one enrollment, stamping `updatedAt`. */
    private async mutateEnrollment(enrollmentId: string, mutate: (enrollment: PendingEnrollment) => void): Promise<void> {
        await this.updateStore(async (store) => {
            const current: PendingEnrollment = await this.requireEnrollment(store, enrollmentId);
            mutate(current);
            current.updatedAt = new Date().toISOString();
        });
    }

    /**
     * Forces an immediate re-check of one enrollment: the same step the background job takes on its next tick - and, when that step
     * was answering the CA's challenge, the poll of the order that would otherwise wait for the tick after - plus a look at the
     * order while the challenge e-mail is still awaited. Answers with the resulting progress.
     *
     * - **Rate limited per enrollment** (`minIntervalMs`, default 10 s, persisted as `lastForcedCheckAt`): a repeat inside it is a 429
     * with `retryAfterSeconds` on the error. Only enrollments still pending are checked or limited - a finished one just answers.
     * - **Never blocks for long**: past `timeoutMs` (default 8 s) it answers with the current state and a `note`; the step it
     * started keeps running and its result lands in the record.
     * - **Never throws for a CA problem**: an unreachable CA or a failed reply is in the answer (`errorCode`, `note`), as it is in
     * the record. Only an unknown id (404) and the rate limit are errors.
     */
    public async checkNow(enrollmentId: string, options: { timeoutMs?: number; minIntervalMs?: number } = {}): Promise<EnrollmentProgress> {
        const timeoutMs: number = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
        const minIntervalMs: number = options.minIntervalMs ?? DEFAULT_CHECK_MIN_INTERVAL_MS;
        const found: PendingEnrollment = await this.requireEnrollment(await this.loadStore(), enrollmentId);
        if (found.status !== "pending") {
            return this.toProgress(found);
        }

        const retryAfter: number = await this.updateStore(async (store) => {
            const current: PendingEnrollment = await this.requireEnrollment(store, enrollmentId);
            const now: number = Date.now();
            const last: number = current.lastForcedCheckAt ? Date.parse(current.lastForcedCheckAt) : Number.NEGATIVE_INFINITY;
            if (now - last < minIntervalMs) {
                return Math.max(1, Math.ceil((minIntervalMs - (now - last)) / 1000));
            }
            current.lastForcedCheckAt = new Date(now).toISOString();
            return 0;
        });
        if (retryAfter > 0) {
            const err = new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 429, `This enrollment was checked a moment ago. Try again in ${retryAfter} seconds.`);
            (err as any).retryAfterSeconds = retryAfter;
            throw err;
        }

        const run: Promise<"done"> = (async () => {
            await this.advance(enrollmentId, true);
            // The reply just went out: the CA has the challenge now, so ask how it is doing rather than leave that to the next tick.
            if (found.replySentAt === undefined && (await this.requireEnrollment(await this.loadStore(), enrollmentId)).replySentAt !== undefined) {
                await this.advance(enrollmentId, true);
            }
            return "done" as const;
        })();
        let timer: NodeJS.Timeout | undefined;
        const outcome: "done" | "timeout" = await Promise.race([
            // A CA problem is already recorded on the enrollment (`lastError`) and reported by `toProgress()`.
            run.catch((): "done" => "done"),
            new Promise<"timeout">((resolve) => {
                timer = setTimeout(() => resolve("timeout"), timeoutMs);
            }),
        ]);
        clearTimeout(timer);

        const progress: EnrollmentProgress = this.toProgress(await this.requireEnrollment(await this.loadStore(), enrollmentId));
        if (outcome === "timeout") {
            progress.note = "The certificate authority is taking longer than usual to answer. The check is still running - the status will update shortly.";
        }
        return progress;
    }

    /** See `SigningCertificateEnrollment.describeProgress()`. */
    public async describeProgress(enrollmentId: string): Promise<EnrollmentProgress> {
        return this.toProgress(await this.requireEnrollment(await this.loadStore(), enrollmentId));
    }

    /** See `SigningCertificateEnrollment.listEnrollments()`. */
    public async listEnrollments(): Promise<EnrollmentSummary[]> {
        return Object.entries(await this.loadStore()).map(([enrollmentId, enrollment]) => ({
            enrollmentId,
            identity: enrollment.identity,
            mailboxUid: enrollment.mailboxUid,
            status: enrollment.status,
            createdAt: enrollment.createdAt,
            installedAt: enrollment.installedAt,
        }));
    }

    /** The `EnrollmentProgress` of `enrollment` - see `pki/EnrollmentStages.ts` for the stages and `EnrollmentProgress` for each field. */
    private toProgress(enrollment: PendingEnrollment): EnrollmentProgress {
        const milestones: AcmeMilestones = {
            status: enrollment.status,
            createdAt: enrollment.createdAt,
            challengeReceivedAt: enrollment.challengeReceivedAt,
            hasDigest: enrollment.digest !== undefined,
            replySentAt: enrollment.replySentAt,
            finalizedAt: enrollment.finalizedAt,
            issuedAt: enrollment.issuedAt,
            failedAt: enrollment.failedAt,
            orderStatus: enrollment.orderStatus,
        };
        const { stage, stages, progress } = computeStages(milestones);
        const result: EnrollmentProgress = {
            status: enrollment.status,
            certificate: enrollment.certificate,
            error: enrollment.error,
            stage,
            stages,
            progress,
            requestedAt: enrollment.createdAt,
            updatedAt: enrollment.updatedAt ?? enrollment.createdAt,
        };
        if (enrollment.lastCheckedAt) {
            result.lastCheckedAt = enrollment.lastCheckedAt;
        }
        if (enrollment.status === "pending") {
            result.nextCheckAt = new Date(Date.parse(enrollment.lastCheckedAt ?? enrollment.createdAt) + this.pollIntervalSeconds * 1000).toISOString();
            if (enrollment.lastError) {
                result.errorCode = enrollment.lastError.code;
                result.retryable = true;
                result.note = enrollment.lastError.message;
            }
        } else if (enrollment.status === "failed") {
            result.errorCode = enrollment.errorCode ?? "failed";
            result.retryable = enrollment.retryable ?? true;
        } else {
            Object.assign(result, certificateDetails(enrollment.certificate));
        }
        if (enrollment.issuedAt) {
            result.issuedAt = enrollment.issuedAt;
        }
        if (enrollment.installedAt) {
            result.installedAt = enrollment.installedAt;
        }
        return result;
    }

    /**
     * Composes and sends the RFC 8823 reply email exactly per spec: `To` is the challenge email's own
     * `Reply-To` (falling back to its `From`, already resolved into `enrollment.replyTo` by
     * `recordChallengeToken()`), `Subject` is `Re: ` plus the challenge's own subject (the RFC permits,
     * without requiring, a reply prefix), `In-Reply-To` is the challenge's `Message-ID`, and the
     * `text/plain` body carries the digest inside the exact `BEGIN`/`END ACME RESPONSE` marker lines the
     * CA parses for. Sent via `scanAndRelay()` (not a raw `mailTransport.send()`) since, unlike a
     * best-effort notification (`sendRecallReport()`'s own precedent), this is the one message a failure
     * to relay would silently stall the entire enrollment on.
     */
    private async sendChallengeReply(enrollment: PendingEnrollment): Promise<void> {
        const composed: Buffer = await new MailComposer({
            from: enrollment.identity,
            to: enrollment.replyTo,
            subject: `Re: ${enrollment.challengeSubject}`,
            inReplyTo: enrollment.challengeMessageId,
            references: enrollment.challengeMessageId,
            text: `-----BEGIN ACME RESPONSE-----\n${enrollment.digest}\n-----END ACME RESPONSE-----\n`,
        })
            .compile()
            .build();

        await scanAndRelay(composed, enrollment.identity, [enrollment.replyTo!], this.scanPipeline!, this.mailTransport, this.blobStore!);
    }
}
