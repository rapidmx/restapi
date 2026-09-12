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
import * as fs from "fs/promises";
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
import { EnrollmentResult, SigningCertificateEnrollment } from "./SigningCertificateEnrollment.js";
const { Config, Inject, Logger } = ObjectDecorators;

x509.cryptoProvider.set(crypto);

/** One in-progress RFC 8823 enrollment, from `startEnrollment()` through to a downloaded certificate.
 * Everything needed to resume across a process restart lives here - see `loadStore()`/`saveStore()`. */
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
    tokenPart1?: string;
    /** The address the reply email must be sent `To:` - the challenge email's own `Reply-To` header,
     * falling back to its `From` (see `recordChallengeToken()`'s own doc comment). */
    replyTo?: string;
    challengeMessageId?: string;
    challengeSubject?: string;
    /** base64url(SHA-256(keyAuthorization)) - the exact value RFC 8823's reply email body carries.
     * Computed once by `recordChallengeToken()`; a later piece of this feature sends the reply email
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

    /** Loads this deployment's one persisted ACME account (key + account URL), registering a new one
     * on first use. Idempotent and safe to call before every operation - once minted, the account is
     * stable for the deployment's lifetime, the same reasoning `LocalX509CertificateAuthority.
     * ensureCa()` already documents for its own root key. */
    private async ensureAccount(): Promise<acme.Client> {
        try {
            const [accountKey, accountUrl] = await Promise.all([
                fs.readFile(this.accountKeyPath(), "utf-8"),
                fs.readFile(this.accountUrlPath(), "utf-8"),
            ]);
            return this.createClient({ directoryUrl: this.directoryUrl, accountKey, accountUrl: accountUrl.trim() });
        } catch (err: any) {
            if (err.code !== "ENOENT") {
                throw err;
            }
        }

        const accountKey: Buffer = await acme.crypto.createPrivateEcdsaKey("P-256");
        const client: acme.Client = this.createClient({ directoryUrl: this.directoryUrl, accountKey });
        await client.createAccount({
            termsOfServiceAgreed: true,
            contact: this.contactEmail ? [`mailto:${this.contactEmail}`] : undefined,
        });

        await fs.mkdir(this.storeDir, { recursive: true, mode: 0o700 });
        try {
            // Atomic create-or-fail, same TOCTOU-tolerant reasoning as `LocalX509CertificateAuthority.
            // ensureCa()` - two concurrent first-ever calls can both observe `ENOENT` above; the loser
            // re-reads the winner's already-registered account instead of orphaning a second one.
            await fs.writeFile(this.accountKeyPath(), accountKey, { mode: 0o600, flag: "wx" });
        } catch (err: any) {
            if (err.code === "EEXIST") {
                return this.ensureAccount();
            }
            throw err;
        }
        await fs.writeFile(this.accountUrlPath(), client.getAccountUrl(), { mode: 0o600, flag: "wx" });
        this.logger?.info(`Rfc8823AcmeSigningCertificateEnrollment: registered new ACME account at '${this.directoryUrl}'.`);

        return client;
    }

    private async loadStore(): Promise<Record<string, PendingEnrollment>> {
        try {
            return JSON.parse(await fs.readFile(this.enrollmentsPath(), "utf-8"));
        } catch (err: any) {
            if (err.code !== "ENOENT") {
                throw err;
            }
            return {};
        }
    }

    private async saveStore(store: Record<string, PendingEnrollment>): Promise<void> {
        await fs.mkdir(this.storeDir, { recursive: true, mode: 0o700 });
        await fs.writeFile(this.enrollmentsPath(), JSON.stringify(store), { mode: 0o600 });
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
        const store: Record<string, PendingEnrollment> = await this.loadStore();
        store[enrollmentId] = {
            identity,
            csr,
            orderUrl: order.url,
            orderFinalizeUrl: order.finalize,
            authorizationUrl: authorization.url,
            challengeUrl: challenge.url,
            challengeFrom: challenge.from,
            tokenPart2: challenge.token,
            status: "pending",
            createdAt: new Date().toISOString(),
        };
        await this.saveStore(store);

        this.logger?.info(`Rfc8823AcmeSigningCertificateEnrollment: started enrollment '${enrollmentId}' for '${identity}'.`);
        return { enrollmentId };
    }

    /**
     * Finds the pending enrollment (if any) still awaiting its RFC 8823 challenge email for
     * `identity`, whose challenge is expected to arrive `from` that exact address - the inbound
     * mail-ingest pipeline's own correlator (`ScanQueueJob`) calls this for every candidate message
     * (one whose `Auto-Submitted`/`Subject` shape already looks like an ACME challenge) before ever
     * treating it as CA plumbing, since nothing in the challenge email itself carries this server's
     * own `enrollmentId` - only a real, still-outstanding enrollment for this exact (identity, from)
     * pair should ever be matched. Comparison is case-insensitive (email addresses' domain part is
     * always case-insensitive, and the local part is, in practice, treated the same way by virtually
     * every real mailbox).
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
                enrollment.tokenPart1 === undefined &&
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
     * Idempotent - a duplicate delivery of the same challenge email (or a retry) leaves an
     * already-recorded token-part1 untouched rather than recomputing (and potentially invalidating,
     * were the two deliveries to ever differ) the digest.
     *
     * @param enrollmentId An identifier previously returned by `startEnrollment()`.
     * @throws If `enrollmentId` is not recognized.
     */
    public async recordChallengeToken(
        enrollmentId: string,
        tokenPart1: string,
        replyTo: string,
        messageId: string,
        subject: string,
    ): Promise<void> {
        const store: Record<string, PendingEnrollment> = await this.loadStore();
        const enrollment: PendingEnrollment = await this.requireEnrollment(store, enrollmentId);
        if (enrollment.tokenPart1 !== undefined) {
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

        enrollment.tokenPart1 = tokenPart1;
        enrollment.replyTo = replyTo;
        enrollment.challengeMessageId = messageId;
        enrollment.challengeSubject = subject;
        enrollment.digest = digest;
        await this.saveStore(store);
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
    public async attachWrappedKey(enrollmentId: string, wrappedKey: Omit<WrappedPrivateKey, "fingerprint" | "useType">): Promise<void> {
        const store: Record<string, PendingEnrollment> = await this.loadStore();
        const enrollment: PendingEnrollment = await this.requireEnrollment(store, enrollmentId);
        enrollment.wrappedKey = wrappedKey;
        await this.saveStore(store);
    }

    /**
     * Every enrollment a driver job still has work to do for: either `status === "pending"` (needs
     * `advanceEnrollment()`) or `status === "issued"` with no `installedAt` yet (needs installing) - see
     * `AcmeEnrollmentDriverJob`, this feature's own follow-on piece. Keeping both in one list means a
     * failed install attempt (network blip, a since-deleted mailbox) naturally gets retried on the next
     * tick rather than being lost the moment `status` leaves `"pending"`. Never includes the CSR/wrapped-
     * key contents themselves - a caller that needs those re-reads via `checkStatus()`/`getIssuedMaterial()`.
     */
    public async listPendingEnrollments(): Promise<Array<{ enrollmentId: string; identity: string; status: PendingEnrollment["status"] }>> {
        const store: Record<string, PendingEnrollment> = await this.loadStore();
        return Object.entries(store)
            .filter(([, enrollment]) => enrollment.status === "pending" || (enrollment.status === "issued" && enrollment.installedAt === undefined))
            .map(([enrollmentId, enrollment]) => ({ enrollmentId, identity: enrollment.identity, status: enrollment.status }));
    }

    /**
     * Records that `AcmeEnrollmentDriverJob` has successfully installed this `"issued"` enrollment's
     * certificate into the mailbox's `KeyVault` - `listPendingEnrollments()` stops returning it afterward.
     *
     * @throws If `enrollmentId` is not recognized.
     */
    public async markInstalled(enrollmentId: string): Promise<void> {
        const store: Record<string, PendingEnrollment> = await this.loadStore();
        const enrollment: PendingEnrollment = await this.requireEnrollment(store, enrollmentId);
        enrollment.installedAt = new Date().toISOString();
        await this.saveStore(store);
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
    ): Promise<{ certificate: string; wrappedKey: Omit<WrappedPrivateKey, "fingerprint" | "useType"> } | undefined> {
        const store: Record<string, PendingEnrollment> = await this.loadStore();
        const enrollment: PendingEnrollment = await this.requireEnrollment(store, enrollmentId);
        if (enrollment.status !== "issued" || !enrollment.certificate || !enrollment.wrappedKey) {
            return undefined;
        }
        return { certificate: enrollment.certificate, wrappedKey: enrollment.wrappedKey };
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
        const store: Record<string, PendingEnrollment> = await this.loadStore();
        const enrollment: PendingEnrollment = await this.requireEnrollment(store, enrollmentId);
        if (enrollment.status !== "pending" || enrollment.digest === undefined) {
            return;
        }

        const client: acme.Client = await this.ensureAccount();

        if (enrollment.replySentAt === undefined) {
            await this.sendChallengeReply(enrollment);
            await client.completeChallenge({ url: enrollment.challengeUrl, status: "pending" } as any);
            enrollment.replySentAt = new Date().toISOString();
            await this.saveStore(store);
            return;
        }

        const order: acme.Order = await client.getOrder({ url: enrollment.orderUrl } as any);
        if (order.status === "invalid") {
            enrollment.status = "failed";
            enrollment.error = order.error ? JSON.stringify(order.error) : "The certificate authority marked this order invalid.";
            await this.saveStore(store);
        } else if (order.status === "ready") {
            await client.finalizeOrder({ url: enrollment.orderUrl, finalize: enrollment.orderFinalizeUrl } as any, enrollment.csr);
            // Finalizing transitions the order to "processing" server-side - the next call to this method
            // re-fetches and observes that, no local state to persist here.
        } else if (order.status === "valid") {
            const certificate: string = await client.getCertificate({ url: enrollment.orderUrl, status: "valid" } as any);
            enrollment.status = "issued";
            enrollment.certificate = certificate;
            await this.saveStore(store);
        }
        // "pending"/"processing": still waiting on the CA - nothing to do until the next call.
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
