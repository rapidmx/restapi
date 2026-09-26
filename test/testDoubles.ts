///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Lightweight, deterministic test-double implementations of this library's pluggable interfaces
// (`BlobStore`, `SearchProvider`, `SpamScanProvider`, `AvScanProvider`, `MailTransport`, `DnsResolver`,
// `DkimKeyProvider`, `EncryptionCertificateAuthority`, `SigningCertificateEnrollment`), registered with an
// `ObjectFactory` under the same string names the library's `@Inject("...")` decorators resolve against. Every
// integration test that boots the shared `test/server-mongo`/`test/server-sql` fixture app needs these
// registered *before* `server.start()`, because `Server` eagerly instantiates every route it discovers -
// including routes (Attachment/Message/MailIngest/Search) that inject these interfaces - regardless of which
// specific route a given test file is exercising. This is a deliberate departure from `@rapidrest/auth`'s "no
// shared test utility" convention: this library has pluggable interfaces auth does not, and duplicating this
// registration across ~24 integration test files would be unreasonable.
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import type { BlobPutOptions, BlobRange, BlobStore } from "../src/blob/BlobStore.js";
import type { DnsMxRecord, DnsResolver, DnsSrvRecord } from "../src/dns/DnsResolver.js";
import type {
    CandidateQuery,
    CandidateResultPage,
    SearchDocument,
    SearchEntityType,
    SearchProvider,
    SearchQuery,
    SearchResultPage,
} from "../src/search/SearchProvider.js";
import type { ScanEnvelope, SpamLearnOptions, SpamScanProvider, SpamScanResult } from "../src/scan/SpamScanProvider.js";
import type { AvScanProvider, AvScanResult } from "../src/scan/AvScanProvider.js";
import type { MailTransport, OutboundMessage, TransportResult } from "../src/transport/MailTransport.js";
import { NullDkimKeyProvider } from "../src/dkim/NullDkimKeyProvider.js";
import { NullEncryptionCertificateAuthority } from "../src/pki/NullEncryptionCertificateAuthority.js";
import { NullSigningCertificateEnrollment } from "../src/pki/NullSigningCertificateEnrollment.js";
import type { EncryptionCertificateAuthority, IssuedCertificate } from "../src/pki/EncryptionCertificateAuthority.js";
import { AvVerdict, SpamVerdict } from "../src/models/types.js";
import type { ObjectFactory } from "@rapidrest/service-core";

x509.cryptoProvider.set(crypto);

/** An in-memory `BlobStore` — content lives only for the lifetime of the process. */
export class InMemoryBlobStore implements BlobStore {
    private store: Map<string, Buffer> = new Map();

    public async put(key: string, data: Buffer | NodeJS.ReadableStream, _options?: BlobPutOptions): Promise<void> {
        if (Buffer.isBuffer(data)) {
            this.store.set(key, data);
            return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of data as any) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        this.store.set(key, Buffer.concat(chunks));
    }

    public async get(key: string): Promise<Buffer> {
        const value: Buffer | undefined = this.store.get(key);
        if (!value) {
            throw new Error(`InMemoryBlobStore: no blob at key '${key}'`);
        }
        return value;
    }

    public async getStream(key: string, range?: BlobRange): Promise<NodeJS.ReadableStream> {
        const { Readable } = await import("stream");
        const full: Buffer = await this.get(key);
        const content: Buffer = range ? full.subarray(range.start, range.end !== undefined ? range.end + 1 : undefined) : full;
        return Readable.from(content);
    }

    public async delete(key: string): Promise<void> {
        this.store.delete(key);
    }

    public async exists(key: string): Promise<boolean> {
        return this.store.has(key);
    }

    public async size(key: string): Promise<number> {
        return (await this.get(key)).length;
    }
}

/** A `SearchProvider` that records indexed documents in memory and does simple substring matching on search. */
export class NoopSearchProvider implements SearchProvider {
    public readonly name: string = "noop";
    public indexed: Map<string, SearchDocument> = new Map();

    private key(entityType: SearchEntityType, entityUid: string): string {
        return `${entityType}:${entityUid}`;
    }

    public async index(doc: SearchDocument): Promise<void> {
        this.indexed.set(this.key(doc.entityType, doc.entityUid), doc);
    }

    public async bulkIndex(docs: SearchDocument[]): Promise<string[]> {
        for (const doc of docs) {
            await this.index(doc);
        }
        return docs.map((doc) => doc.entityUid);
    }

    public async remove(entityType: SearchEntityType, entityUid: string): Promise<void> {
        this.indexed.delete(this.key(entityType, entityUid));
    }

    public async search(query: SearchQuery): Promise<SearchResultPage> {
        const results = Array.from(this.indexed.values())
            .filter((doc) => doc.mailboxUid === query.mailboxUid)
            .filter((doc) => !query.entityTypes || query.entityTypes.includes(doc.entityType))
            .filter((doc) => !query.text || (doc.subject ?? "").includes(query.text) || (doc.body ?? "").includes(query.text))
            .filter((doc) => query.subject === undefined || (doc.subject ?? "").includes(query.subject))
            .filter((doc) => query.from === undefined || doc.from === query.from)
            .filter((doc) => query.to === undefined || (doc.to ?? []).includes(query.to))
            .filter((doc) => query.cc === undefined || (doc.cc ?? []).includes(query.cc))
            .filter((doc) => query.hasAttachment === undefined || doc.hasAttachments === query.hasAttachment)
            .filter((doc) => query.folderUid === undefined || doc.folderUid === query.folderUid)
            .filter((doc) => !query.flags || query.flags.every((f) => (doc.flags ?? []).includes(f)))
            .map((doc) => ({ entityType: doc.entityType, entityUid: doc.entityUid, score: 1, metadataOnly: doc.metadataOnly }));
        return { results };
    }

    public async candidates(query: CandidateQuery): Promise<CandidateResultPage> {
        const candidates = Array.from(this.indexed.values())
            .filter((doc) => doc.mailboxUid === query.mailboxUid)
            .filter((doc) => !query.entityTypes || query.entityTypes.includes(doc.entityType))
            .filter((doc) => query.folderUid === undefined || doc.folderUid === query.folderUid)
            .filter((doc) => !query.flags || query.flags.every((f) => (doc.flags ?? []).includes(f)))
            .filter((doc) => !query.participants || query.participants.some((p) => (doc.participants ?? []).includes(p)))
            .map((doc) => ({ entityType: doc.entityType, entityUid: doc.entityUid }));
        return { candidates };
    }
}

/**
 * A `SpamScanProvider` that reports a message as clean unless its raw content contains the marker
 * string `"X-Test-Force-Spam: true"`, in which case it reports SPAM. This lets an integration test
 * exercise `BaseMessageRoute.send()`'s spam-rejection (422) path via a real HTTP request - by including
 * that header in the message body it hands to the route - rather than needing a mocked ScanPipeline.
 *
 * It also records what it is taught (`learn()`, called by `POST /messages/:id/report`) in `learned`, and fails every lesson with
 * `learnError` while that is set.
 */
export class AlwaysCleanSpamScanProvider implements SpamScanProvider {
    public readonly name: string = "always-clean";

    /** Every message `learn()` accepted, oldest first. */
    public learned: { kind: "spam" | "ham"; raw: Buffer; options?: SpamLearnOptions }[] = [];

    /** While set, `learn()` rejects with it instead of recording. */
    public learnError?: Error;

    public async learn(raw: Buffer, kind: "spam" | "ham", options?: SpamLearnOptions): Promise<void> {
        if (this.learnError) {
            throw this.learnError;
        }
        this.learned.push({ kind, raw, options });
    }

    public async scoreMessage(raw: Buffer, _envelope: ScanEnvelope): Promise<SpamScanResult> {
        if (raw.includes("X-Test-Force-Spam: true")) {
            return { score: 100, verdict: SpamVerdict.SPAM, symbols: ["TEST_FORCED_SPAM"] };
        }
        return { score: 0, verdict: SpamVerdict.CLEAN, symbols: [] };
    }
}

/**
 * An `AvScanProvider` that reports content as clean unless it contains one of two marker strings:
 * `"X-Test-Force-Infected: true"` (reports INFECTED) or `"X-Test-Force-Av-Error: true"` (reports ERROR, the
 * providers' own documented fail-closed outcome for a scan-engine outage). Lets a test exercise a real
 * `ScanPipeline`'s/`ScanQueueJob`'s quarantine path via genuine content - by including the marker in the raw
 * message or an attachment's bytes - rather than needing a mocked AvScanProvider.
 */
export class AlwaysCleanAvScanProvider implements AvScanProvider {
    public readonly name: string = "always-clean";

    public async scanBuffer(content: Buffer, _filename?: string): Promise<AvScanResult> {
        if (content.includes("X-Test-Force-Infected: true")) {
            return { verdict: AvVerdict.INFECTED, signatureName: "Test-Signature" };
        }
        if (content.includes("X-Test-Force-Av-Error: true")) {
            return { verdict: AvVerdict.ERROR };
        }
        return { verdict: AvVerdict.CLEAN };
    }
}

/**
 * A `MailTransport` that records every message it was asked to send, without relaying anywhere. Rejects
 * (accepts none of) any envelope recipient whose address is exactly `reject@example.com`, so an
 * integration test can exercise `BaseMessageRoute.send()`'s transport-rejection (502) path via a real
 * HTTP request - by addressing the message to that recipient - rather than needing a mocked
 * MailTransport. `temp-fail@example.com` is refused too, but with a temporary (4xx) failure a retry can fix. Setting `gate`
 * holds every send until it resolves, and `inFlight`/`maxInFlight` say how many sends were running at once - what a test
 * of a background send needs to prove the request did not wait for the relay.
 */
export class RecordingMailTransport implements MailTransport {
    public readonly name: string = "recording";
    public sent: OutboundMessage[] = [];

    /** While set, `send()` waits for it before doing anything. */
    public gate?: Promise<void>;
    public inFlight: number = 0;
    public maxInFlight: number = 0;

    /** What Postfix says about a recipient it refuses - see `send()`. */
    private static refusal(address: string) {
        return {
            address,
            code: 554,
            enhancedCode: "5.7.1",
            response: `554 5.7.1 <${address}>: Recipient address rejected: Access denied`,
            command: "RCPT TO",
            temporary: false,
        };
    }

    /** `reject@example.com` in the envelope fails the whole call; `partial-reject@...` is refused while the other recipients
     * are accepted. Both come with the diagnostics a real transport reports. */
    public async send(message: OutboundMessage): Promise<TransportResult> {
        this.inFlight++;
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
        try {
            if (this.gate) {
                await this.gate;
            }
            return await this.relay(message);
        } finally {
            this.inFlight--;
        }
    }

    private async relay(message: OutboundMessage): Promise<TransportResult> {
        if (message.envelopeTo.includes("temp-fail@example.com")) {
            const failures = message.envelopeTo.map((address) => ({
                address,
                code: 451,
                enhancedCode: "4.3.0",
                response: `451 4.3.0 <${address}>: Temporary local problem - please try again later`,
                command: "DATA",
                temporary: true,
            }));
            return { accepted: [], rejected: message.envelopeTo, failures, error: { message: "The recording transport is busy.", code: "ETEMP", command: "DATA" } };
        }
        if (message.envelopeTo.includes("reject@example.com")) {
            return {
                accepted: [],
                rejected: message.envelopeTo,
                failures: message.envelopeTo.map(RecordingMailTransport.refusal),
                error: { message: "The recording transport refused the message.", code: "EREJECT", command: "RCPT TO" },
            };
        }
        const refused: string[] = message.envelopeTo.filter((address) => address.startsWith("partial-reject@"));
        if (refused.length > 0 && refused.length < message.envelopeTo.length) {
            const accepted: string[] = message.envelopeTo.filter((address) => !refused.includes(address));
            this.sent.push({ ...message, envelopeTo: accepted });
            return { accepted, rejected: refused, failures: refused.map(RecordingMailTransport.refusal) };
        }
        this.sent.push(message);
        return { accepted: message.envelopeTo, rejected: [] };
    }
}

/**
 * A `DnsResolver` backed by an in-memory `Map` a test populates directly (`resolver.records.set("example.com",
 * [["rapidmx-domain-verification=abc123"]])`) rather than ever touching real DNS. Throws (matching a real
 * resolver's NXDOMAIN/no-records behavior) for any hostname with no entry.
 */
export class StaticDnsResolver implements DnsResolver {
    public records: Map<string, string[][]> = new Map();
    public mxRecords: Map<string, DnsMxRecord[]> = new Map();
    public cnameRecords: Map<string, string[]> = new Map();
    public srvRecords: Map<string, DnsSrvRecord[]> = new Map();

    public async resolveTxt(hostname: string): Promise<string[][]> {
        const records: string[][] | undefined = this.records.get(hostname);
        if (!records) {
            throw new Error(`StaticDnsResolver: no TXT records for '${hostname}'`);
        }
        return records;
    }

    public async resolveMx(hostname: string): Promise<DnsMxRecord[]> {
        const records: DnsMxRecord[] | undefined = this.mxRecords.get(hostname);
        if (!records) {
            throw new Error(`StaticDnsResolver: no MX records for '${hostname}'`);
        }
        return records;
    }

    public async resolveCname(hostname: string): Promise<string[]> {
        const records: string[] | undefined = this.cnameRecords.get(hostname);
        if (!records) {
            throw new Error(`StaticDnsResolver: no CNAME records for '${hostname}'`);
        }
        return records;
    }

    public async resolveSrv(hostname: string): Promise<DnsSrvRecord[]> {
        const records: DnsSrvRecord[] | undefined = this.srvRecords.get(hostname);
        if (!records) {
            throw new Error(`StaticDnsResolver: no SRV records for '${hostname}'`);
        }
        return records;
    }
}

/**
 * A real, working `EncryptionCertificateAuthority` for tests that actually need a key enrolled (unlike the
 * default `NullEncryptionCertificateAuthority`, which throws) - an in-memory-only simplification of
 * `LocalX509CertificateAuthority` (same CSR-verification/issuance logic, minus the on-disk CA-key
 * persistence, which a test has no reason to exercise). Not registered by `registerTestDoubles()` itself -
 * a test file that needs real key enrollment registers this in place of `NullEncryptionCertificateAuthority`
 * itself, via `objectFactory.register(FakeEncryptionCertificateAuthority, "EncryptionCertificateAuthority")`.
 */
export class FakeEncryptionCertificateAuthority implements EncryptionCertificateAuthority {
    public readonly name: string = "fake";
    private ca?: { keys: CryptoKeyPair; cert: x509.X509Certificate };

    private async ensureCa(): Promise<{ keys: CryptoKeyPair; cert: x509.X509Certificate }> {
        if (!this.ca) {
            const keys: CryptoKeyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
                "sign",
                "verify",
            ]);
            const cert: x509.X509Certificate = await x509.X509CertificateGenerator.createSelfSigned({
                name: "CN=Fake Test CA",
                notBefore: new Date(),
                notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
                keys,
                signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
            });
            this.ca = { keys, cert };
        }
        return this.ca;
    }

    public async issue(identity: string, csr: string): Promise<IssuedCertificate> {
        const { keys, cert } = await this.ensureCa();
        const parsedCsr = new x509.Pkcs10CertificateRequest(csr);
        const notBefore = new Date();
        const notAfter = new Date(notBefore.getTime() + 365 * 24 * 60 * 60 * 1000);
        const leaf: x509.X509Certificate = await x509.X509CertificateGenerator.create({
            subject: `CN=${identity}`,
            issuer: cert.subjectName,
            notBefore,
            notAfter,
            publicKey: parsedCsr.publicKey,
            signingKey: keys.privateKey,
            signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        });
        const fingerprint: string = Buffer.from(await leaf.getThumbprint("SHA-256")).toString("hex");
        return { certificate: leaf.toString("pem"), fingerprint, notBefore, notAfter, serialNumber: leaf.serialNumber };
    }

    public async revoke(_fingerprint: string): Promise<void> {
        // Intentionally empty - no test needs revocation state tracked.
    }
}

/** Generates a fresh P-256 self-signed PKCS#10 CSR for `identity` - the client-side half of the encryption-
 * key enrollment flow, needed by any test that calls `POST /mailbox/:id/keyvault/keys`. */
export async function generateTestCsr(identity: string): Promise<string> {
    const keys: CryptoKeyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
    ]);
    const csr = await x509.Pkcs10CertificateRequestGenerator.create({
        name: `CN=${identity}`,
        keys,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    });
    return csr.toString("pem");
}

/**
 * Registers a full set of test-double implementations for this library's pluggable interfaces against
 * `objectFactory`. Call this before `server.start()` in any integration test that boots the shared server
 * fixture apps.
 */
export function registerTestDoubles(objectFactory: ObjectFactory): void {
    objectFactory.register(InMemoryBlobStore, "BlobStore");
    objectFactory.register(NoopSearchProvider, "SearchProvider");
    objectFactory.register(AlwaysCleanSpamScanProvider, "SpamScanProvider");
    objectFactory.register(AlwaysCleanAvScanProvider, "AvScanProvider");
    objectFactory.register(RecordingMailTransport, "MailTransport");
    objectFactory.register(StaticDnsResolver, "DnsResolver");
    objectFactory.register(NullDkimKeyProvider, "DkimKeyProvider");
    objectFactory.register(NullEncryptionCertificateAuthority, "EncryptionCertificateAuthority");
    objectFactory.register(NullSigningCertificateEnrollment, "SigningCertificateEnrollment");
}
