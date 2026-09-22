///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Signing certificates through HTTP, identical on both backends: the administrator's routes (`/admin/signing-enrollments`: list, CSR, upload,
// reject - trusted role AND elevated token, audited, and nothing else granted), the info route (`GET /system/signing-enrollment`), and what the
// key-vault status routes answer for an enrollment the active provider does not know. The provider behind the injected
// `SigningCertificateEnrollment` is switched per test (`SwitchableEnrollment`): the real manual provider on a temporary file, the real RFC 8823 one on a
// fake ACME client, the `Null` default, and small fakes for the shapes of implementations the routes must tolerate.
// `test/routes/{mongo,sql}/SigningEnrollmentAdmin.test.ts` supply the server.
import { request } from "@rapidrest/service-core/test";
import * as uuid from "uuid";
import { AuditAction } from "../../src/models/types.js";
import { ManualSigningCertificateEnrollment } from "../../src/pki/ManualSigningCertificateEnrollment.js";
import { NullSigningCertificateEnrollment } from "../../src/pki/NullSigningCertificateEnrollment.js";
import { FakeAcmeClient, generateCsr, type TestEnrollment } from "../pki/acmeTestDoubles.js";
import { createTestCa, generateCsrWithKeys, type TestCa } from "../pki/signingCertTestUtils.js";

/** Registered as the `SigningCertificateEnrollment`: forwards everything to whichever provider `SwitchableEnrollment.target` is. */
export class SwitchableEnrollment {
    public static target: any;

    constructor() {
        return new Proxy(this, {
            get: (self, property) => {
                // What the factory set on the instance itself (its name, ...) stays; everything else is the provider's.
                if (property === "constructor" || Object.prototype.hasOwnProperty.call(self, property)) {
                    return Reflect.get(self, property);
                }
                const value = SwitchableEnrollment.target?.[property];
                return typeof value === "function" ? value.bind(SwitchableEnrollment.target) : value;
            },
        });
    }
}

export interface SigningEnrollmentAdminSuiteContext {
    app: () => any;
    /** e.g. `/mongo/signing-enrollments-admin`. */
    adminUrl: string;
    /** e.g. `/mongo/signing-enrollment-info`. */
    infoUrl: string;
    /** e.g. `/mongo/mailboxes`. */
    mailboxesUrl: string;
    tokenFor: (user: any) => string;
    createMailbox: (ownerUid: string | undefined) => Promise<any>;
    /** The audit entries of `action` written so far. */
    auditEntries: (action: AuditAction) => Promise<any[]>;
    /** A fresh `ManualSigningCertificateEnrollment` on a temporary store. */
    newManual: () => ManualSigningCertificateEnrollment;
    /** A fresh RFC 8823 provider on a temporary store with the fake ACME client. */
    newAutomatic: () => TestEnrollment;
}

const WRAPPED_KEY = { ciphertext: "ct", nonce: "n", algorithm: "AES-256-GCM" };

export function signingEnrollmentAdminSuite(ctx: SigningEnrollmentAdminSuiteContext): void {
    const person = (roles: string[] = [], elevated: number | undefined = Date.now()): any => ({ uid: uuid.v4(), roles, scopes: [], elevated });
    const owner = person();
    const stranger = person();
    const admin = person(["admin"]);
    const unelevatedAdmin = { ...admin, elevated: undefined };
    const as = (req: any, user: any) => req.set("Authorization", "jwt " + ctx.tokenFor(user));
    const admins = (path: string = "") => `${ctx.adminUrl}${path}`;
    const enrollmentsOf = (mailbox: any) => `${ctx.mailboxesUrl}/${mailbox.uid}/keyvault/keys/sign-enrollment`;
    let ca: TestCa;
    let manual: ManualSigningCertificateEnrollment;

    /** The owner asks for a signing certificate for a new mailbox through the real route (so the wrapped key and the binding are attached). */
    const requestCertificate = async (): Promise<{ mailbox: any; enrollmentId: string; csr: string }> => {
        const mailbox = await ctx.createMailbox(owner.uid);
        const csr = await generateCsr(mailbox.primarySmtpAddress);
        const res = await as(request(ctx.app()).post(enrollmentsOf(mailbox)), owner).send({ csr, wrappedKey: WRAPPED_KEY });
        expect(res.status).toBe(200);
        return { mailbox, enrollmentId: res.body.enrollmentId, csr };
    };
    /** A certificate the test CA issues for `csr`. */
    const issue = (csr: string, mailbox: any, options: any = {}) => ca.issue(csr, { email: mailbox.primarySmtpAddress, ...options });

    beforeAll(async () => {
        ca = await createTestCa();
    });
    beforeEach(() => {
        FakeAcmeClient.reset();
        manual = ctx.newManual();
        SwitchableEnrollment.target = manual;
    });

    describe("access: a trusted role AND an elevated token, and nothing else", () => {
        const calls: Array<[string, (user?: any) => any]> = [
            ["GET /", (user) => (user ? as(request(ctx.app()).get(admins()), user) : request(ctx.app()).get(admins()))],
            ["GET /:id/csr", (user) => (user ? as(request(ctx.app()).get(admins("/x/csr")), user) : request(ctx.app()).get(admins("/x/csr")))],
            ["POST /:id/certificate", (user) => (user ? as(request(ctx.app()).post(admins("/x/certificate")), user) : request(ctx.app()).post(admins("/x/certificate"))).send({ certificate: "x" })],
            ["POST /:id/reject", (user) => (user ? as(request(ctx.app()).post(admins("/x/reject")), user) : request(ctx.app()).post(admins("/x/reject"))).send({ reason: "x" })],
        ];

        it.each(calls)("%s is refused to an anonymous caller, an ordinary user (api-103) and an unelevated administrator (api-104)", async (_name, call) => {
            expect([401, 403]).toContain((await call()).status);
            const ordinary = await call(stranger);
            expect([ordinary.status, ordinary.body.code]).toEqual([403, "api-103"]);
            const unelevated = await call(unelevatedAdmin);
            expect([unelevated.status, unelevated.body.code]).toEqual([403, "api-104"]);
        });

        it("grants an administrator nothing of a mailbox: its status and key vault stay owner-only, and the admin routes never show a key", async () => {
            const { mailbox, enrollmentId } = await requestCertificate();

            expect((await as(request(ctx.app()).get(`${enrollmentsOf(mailbox)}/${enrollmentId}`), admin)).status).toBe(403);
            expect((await as(request(ctx.app()).get(`${ctx.mailboxesUrl}/${mailbox.uid}/keyvault`), admin)).status).toBe(403);
            const listed = await as(request(ctx.app()).get(admins()), admin);
            expect(listed.status).toBe(200);
            expect(JSON.stringify(listed.body)).not.toMatch(/ciphertext|wrappedKey|BEGIN/);
        });
    });

    describe("manual provider", () => {
        it("lists the pending requests as metadata: address, mailbox, when, state, provider", async () => {
            const { mailbox, enrollmentId } = await requestCertificate();

            const res = await as(request(ctx.app()).get(admins()), admin);

            expect(res.status).toBe(200);
            expect(res.body).toEqual([
                {
                    enrollmentId,
                    identity: mailbox.primarySmtpAddress,
                    mailboxUid: mailbox.uid,
                    requestedAt: expect.any(String),
                    status: "pending",
                    provider: "manual",
                    stage: "submitted",
                    canUpload: true,
                },
            ]);
        });

        it("downloads the CSR as a PEM file, and audits it", async () => {
            const { mailbox, enrollmentId, csr } = await requestCertificate();

            const res = await as(request(ctx.app()).get(admins(`/${enrollmentId}/csr`)), admin);

            expect(res.status).toBe(200);
            expect(res.headers["content-type"]).toContain("application/x-pem-file");
            expect(res.headers["content-disposition"]).toBe(`attachment; filename="signing-request-${enrollmentId}.csr"`);
            expect(res.text).toBe(csr);
            const entries = (await ctx.auditEntries(AuditAction.SIGNING_ENROLLMENT_ADMIN_CSR)).filter((entry) => entry.targetUid === enrollmentId);
            expect(entries).toHaveLength(1);
            expect(entries[0]).toEqual(expect.objectContaining({ targetType: "SigningEnrollment", mailboxUid: mailbox.uid, actorUserUid: admin.uid }));
            expect(entries[0].details).toEqual({ address: mailbox.primarySmtpAddress });
        });

        it("accepts the certificate a CA issued, shows it as issued to the mailbox's owner, hands the driver job the certificate with the owner's wrapped key, and audits it", async () => {
            const { mailbox, enrollmentId, csr } = await requestCertificate();
            const certificate = await issue(csr, mailbox);

            const res = await as(request(ctx.app()).post(admins(`/${enrollmentId}/certificate`)), admin).send({ certificate: `${certificate}\n${ca.pem}` });

            expect(res.status).toBe(200);
            expect(res.body).toEqual(
                expect.objectContaining({
                    enrollmentId,
                    identity: mailbox.primarySmtpAddress,
                    status: "issued",
                    chainLength: 2,
                    subject: `CN=${mailbox.primarySmtpAddress}`,
                    issuer: "CN=Test Public CA",
                    serialNumber: expect.any(String),
                    notAfter: expect.any(String),
                    message: expect.stringMatching(/installed into the mailbox by the background job/),
                }),
            );
            const status = await as(request(ctx.app()).get(`${enrollmentsOf(mailbox)}/${enrollmentId}`), owner);
            expect(status.body).toEqual(expect.objectContaining({ provider: "manual", status: "issued", stage: "issued", progress: 100 }));
            expect(await manual.getIssuedMaterial(enrollmentId)).toEqual(
                expect.objectContaining({ wrappedKey: WRAPPED_KEY, mailboxUid: mailbox.uid, certificate: `${certificate}\n${ca.pem}` }),
            );
            const entries = (await ctx.auditEntries(AuditAction.SIGNING_ENROLLMENT_ADMIN_UPLOAD)).filter((entry) => entry.targetUid === enrollmentId);
            expect(entries).toHaveLength(1);
            expect(entries[0].details).toEqual({ address: mailbox.primarySmtpAddress, serialNumber: res.body.serialNumber, notAfter: res.body.notAfter, chainLength: 2 });
        });

        it("refuses a certificate that would not work, with a message to act on, and leaves the request pending and unaudited", async () => {
            const { mailbox, enrollmentId, csr } = await requestCertificate();
            const other = await generateCsrWithKeys(mailbox.primarySmtpAddress);
            const wrongs: Array<[unknown, RegExp]> = [
                [await issue(other.csr, mailbox), /does not match this request's CSR/],
                [await issue(csr, mailbox, { email: "someone@else.com" }), /is for someone@else.com/],
                [await issue(csr, mailbox, { eku: false }), /emailProtection/],
                [await issue(csr, mailbox, { notBefore: new Date(Date.now() - 2 * 86_400_000), notAfter: new Date(Date.now() - 86_400_000) }), /expired/],
                ["garbage", /No PEM certificate/],
                [undefined, /Paste or upload/],
            ];

            for (const [certificate, message] of wrongs) {
                const res = await as(request(ctx.app()).post(admins(`/${enrollmentId}/certificate`)), admin).send(certificate === undefined ? {} : { certificate });
                expect([res.status, res.body.message]).toEqual([400, expect.stringMatching(message)]);
            }
            expect((await manual.checkStatus(enrollmentId)).status).toBe("pending");
            expect((await ctx.auditEntries(AuditAction.SIGNING_ENROLLMENT_ADMIN_UPLOAD)).filter((entry) => entry.targetUid === enrollmentId)).toHaveLength(0);
        });

        it("refuses to upload twice, and to a request made before keys were kept with it", async () => {
            const { mailbox, enrollmentId, csr } = await requestCertificate();
            const certificate = await issue(csr, mailbox);
            await as(request(ctx.app()).post(admins(`/${enrollmentId}/certificate`)), admin).send({ certificate });

            const again = await as(request(ctx.app()).post(admins(`/${enrollmentId}/certificate`)), admin).send({ certificate });
            expect([again.status, again.body.message]).toEqual([409, "This request is already issued."]);

            const oldCsr = await generateCsrWithKeys("old@example.com");
            const { enrollmentId: legacy } = await manual.startEnrollment("old@example.com", oldCsr.csr);
            const listed = await as(request(ctx.app()).get(admins()), admin);
            expect(listed.body.find((row: any) => row.enrollmentId === legacy)).toEqual(expect.objectContaining({ canUpload: false, uploadBlockedReason: expect.stringMatching(/cancel it in Settings/) }));
            const blocked = await as(request(ctx.app()).post(admins(`/${legacy}/certificate`)), admin).send({ certificate: await ca.issue(oldCsr.csr, { email: "old@example.com" }) });
            expect([blocked.status, blocked.body.message]).toEqual([409, expect.stringMatching(/cancel it in Settings/)]);
        });

        it("rejects a request with a reason its owner reads, and audits it", async () => {
            const { mailbox, enrollmentId } = await requestCertificate();

            const res = await as(request(ctx.app()).post(admins(`/${enrollmentId}/reject`)), admin).send({ reason: "  Not an employee\n " });

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ enrollmentId, status: "failed", error: "Rejected by an administrator: Not an employee" });
            const status = await as(request(ctx.app()).get(`${enrollmentsOf(mailbox)}/${enrollmentId}`), owner);
            expect(status.body).toEqual(
                expect.objectContaining({ provider: "manual", status: "failed", error: "Rejected by an administrator: Not an employee", errorCode: "rejected", retryable: true }),
            );
            const entries = (await ctx.auditEntries(AuditAction.SIGNING_ENROLLMENT_ADMIN_REJECT)).filter((entry) => entry.targetUid === enrollmentId);
            expect(entries).toHaveLength(1);
            expect(entries[0].details).toEqual({ address: mailbox.primarySmtpAddress, reason: "Not an employee" });
            expect((await as(request(ctx.app()).get(admins()), admin)).body).toEqual([]);
            const again = await as(request(ctx.app()).post(admins(`/${enrollmentId}/reject`)), admin).send({ reason: "x" });
            expect([again.status, again.body.message]).toEqual([409, "This request is already closed."]);
        });

        it("refuses a rejection without a reason or with one that is too long", async () => {
            const { enrollmentId } = await requestCertificate();

            for (const body of [{}, { reason: "   " }, { reason: 5 }, { reason: "x".repeat(501) }]) {
                const res = await as(request(ctx.app()).post(admins(`/${enrollmentId}/reject`)), admin).send(body);
                expect(res.status).toBe(400);
            }
            expect((await manual.checkStatus(enrollmentId)).status).toBe("pending");
        });

        it("answers an unknown request with the code a client clears a stale id by", async () => {
            for (const res of [
                await as(request(ctx.app()).get(admins("/nope/csr")), admin),
                await as(request(ctx.app()).post(admins("/nope/certificate")), admin).send({ certificate: "x" }),
                await as(request(ctx.app()).post(admins("/nope/reject")), admin).send({ reason: "x" }),
            ]) {
                expect([res.status, res.body.code]).toEqual([404, "signing-enrollment-unknown"]);
            }
        });

        it("audits every list", async () => {
            const before = (await ctx.auditEntries(AuditAction.SIGNING_ENROLLMENT_ADMIN_LIST)).length;

            await as(request(ctx.app()).get(admins()), admin);

            const entries = await ctx.auditEntries(AuditAction.SIGNING_ENROLLMENT_ADMIN_LIST);
            expect(entries).toHaveLength(before + 1);
            expect(entries[entries.length - 1]).toEqual(expect.objectContaining({ actorUserUid: admin.uid, details: { count: expect.any(Number), provider: "manual" } }));
        });
    });

    describe("automatic (RFC 8823) provider", () => {
        beforeEach(() => {
            SwitchableEnrollment.target = ctx.newAutomatic();
        });

        it("lists the pending requests read-only, and refuses every action", async () => {
            const { mailbox, enrollmentId } = await requestCertificate();

            const listed = await as(request(ctx.app()).get(admins()), admin);

            expect(listed.body).toEqual([
                expect.objectContaining({
                    enrollmentId,
                    identity: mailbox.primarySmtpAddress,
                    mailboxUid: mailbox.uid,
                    status: "pending",
                    provider: "rfc8823",
                    stage: "awaiting-challenge",
                    canUpload: false,
                    uploadBlockedReason: expect.stringMatching(/issued automatically/),
                }),
            ]);
            for (const res of [
                await as(request(ctx.app()).get(admins(`/${enrollmentId}/csr`)), admin),
                await as(request(ctx.app()).post(admins(`/${enrollmentId}/certificate`)), admin).send({ certificate: "x" }),
                await as(request(ctx.app()).post(admins(`/${enrollmentId}/reject`)), admin).send({ reason: "x" }),
            ]) {
                expect([res.status, res.body.message]).toEqual([409, expect.stringMatching(/issued automatically by the certificate authority/)]);
            }
            expect((await as(request(ctx.app()).get(`${enrollmentsOf(mailbox)}/${enrollmentId}`), owner)).body.status).toBe("pending");
        });
    });

    describe("no provider (signing certificates disabled)", () => {
        it("lists nothing and refuses every action, saying they are not enabled", async () => {
            SwitchableEnrollment.target = new NullSigningCertificateEnrollment();

            expect((await as(request(ctx.app()).get(admins()), admin)).body).toEqual([]);
            const res = await as(request(ctx.app()).post(admins("/x/reject")), admin).send({ reason: "x" });
            expect([res.status, res.body.message]).toEqual([409, "Signing certificates are not enabled in this deployment."]);
        });

        it("lists nothing for a provider that has no list", async () => {
            SwitchableEnrollment.target = { name: "bare", kind: "manual" };

            expect((await as(request(ctx.app()).get(admins()), admin)).body).toEqual([]);
        });
    });

    describe("GET /system/signing-enrollment", () => {
        it("is refused to an anonymous caller and answers any signed-in user", async () => {
            expect([401, 403]).toContain((await request(ctx.app()).get(ctx.infoUrl)).status);
            expect((await as(request(ctx.app()).get(ctx.infoUrl), stranger)).status).toBe(200);
        });

        it("says the manual backend waits for an administrator", async () => {
            const res = await as(request(ctx.app()).get(ctx.infoUrl), stranger);

            expect(res.body).toEqual({ backend: "manual", automatic: false, adminUpload: true });
        });

        it("says the automatic backend issues through a CA, by host only, how long it takes, and how the CA is doing", async () => {
            const automatic = ctx.newAutomatic();
            (automatic as any).directoryUrl = "https://acme.example:8443/acme/directory?token=secret";
            (automatic as any).contactEmail = "pki@example.com";
            SwitchableEnrollment.target = automatic;

            const healthy = await as(request(ctx.app()).get(ctx.infoUrl), stranger);
            expect(healthy.body).toEqual({
                backend: "rfc8823",
                automatic: true,
                ca: { host: "acme.example:8443" },
                contactEmail: "pki@example.com",
                typicalDurationMinutes: 20,
                adminUpload: false,
                health: { ok: true },
            });

            await automatic.health.record({ ok: false, error: new Error("connect ECONNREFUSED https://acme.example:8443/acme/new-order?token=secret") });
            const failing = await as(request(ctx.app()).get(ctx.infoUrl), stranger);
            expect(failing.body.health).toEqual(expect.objectContaining({ ok: false, lastError: "connect ECONNREFUSED [url acme.example:8443]" }));
            expect(JSON.stringify(failing.body)).not.toMatch(/secret|\/acme\//);
        });

        it("says signing certificates are off with the Null default, and tolerates a provider that says less or fails to say", async () => {
            SwitchableEnrollment.target = new NullSigningCertificateEnrollment();
            expect((await as(request(ctx.app()).get(ctx.infoUrl), stranger)).body).toEqual({ backend: "none", automatic: false, adminUpload: false });

            SwitchableEnrollment.target = { name: "custom" };
            expect((await as(request(ctx.app()).get(ctx.infoUrl), stranger)).body).toEqual({ backend: "none", automatic: false, adminUpload: false });

            SwitchableEnrollment.target = {
                name: "rfc8823-acme",
                kind: "rfc8823",
                describeBackend: async () => {
                    throw new Error("store unreadable");
                },
            };
            expect((await as(request(ctx.app()).get(ctx.infoUrl), stranger)).body).toEqual({ backend: "rfc8823", automatic: true, adminUpload: false });
        });
    });

    describe("the key-vault status routes", () => {
        it("carry the provider on every status, for each provider", async () => {
            const viaManual = await requestCertificate();
            const manualStatus = await as(request(ctx.app()).get(`${enrollmentsOf(viaManual.mailbox)}/${viaManual.enrollmentId}`), owner);
            expect(manualStatus.body.provider).toBe("manual");
            const current = await as(request(ctx.app()).get(enrollmentsOf(viaManual.mailbox)), owner);
            expect(current.body).toEqual(expect.objectContaining({ enrollmentId: viaManual.enrollmentId, provider: "manual" }));
            const checked = await as(request(ctx.app()).post(`${enrollmentsOf(viaManual.mailbox)}/${viaManual.enrollmentId}/check`), owner);
            expect(checked.body.provider).toBe("manual");

            SwitchableEnrollment.target = ctx.newAutomatic();
            const viaAutomatic = await requestCertificate();
            expect((await as(request(ctx.app()).get(`${enrollmentsOf(viaAutomatic.mailbox)}/${viaAutomatic.enrollmentId}`), owner)).body.provider).toBe("rfc8823");
            expect((await as(request(ctx.app()).post(`${enrollmentsOf(viaAutomatic.mailbox)}/${viaAutomatic.enrollmentId}/check`), owner)).body.provider).toBe("rfc8823");
        });

        it("tell an implementation with no progress of its own apart by what it is", async () => {
            const mailbox = await ctx.createMailbox(owner.uid);
            for (const [name, kind, expected] of [
                ["custom", undefined, "manual"],
                ["rfc8823-acme", undefined, "rfc8823"],
                ["custom", "rfc8823", "rfc8823"],
            ] as const) {
                SwitchableEnrollment.target = {
                    name,
                    kind,
                    describeEnrollment: async () => ({ identity: mailbox.primarySmtpAddress }),
                    checkStatus: async () => ({ status: "pending" }),
                };
                const res = await as(request(ctx.app()).get(`${enrollmentsOf(mailbox)}/any`), owner);
                expect([res.status, res.body.provider]).toEqual([200, expected]);
            }
        });

        it("answer an id the active provider does not know - one left over from the manual store after the backend changed - with 404 and a code", async () => {
            const stale = await requestCertificate();
            SwitchableEnrollment.target = ctx.newAutomatic();

            const status = await as(request(ctx.app()).get(`${enrollmentsOf(stale.mailbox)}/${stale.enrollmentId}`), owner);
            const check = await as(request(ctx.app()).post(`${enrollmentsOf(stale.mailbox)}/${stale.enrollmentId}/check`), owner);

            for (const res of [status, check]) {
                expect([res.status, res.body.code]).toEqual([404, "signing-enrollment-unknown"]);
            }
        });

        it("answer another mailbox's enrollment exactly as an unknown one, so which it is stays private", async () => {
            const theirs = await requestCertificate();
            const mine = await ctx.createMailbox(owner.uid);

            const res = await as(request(ctx.app()).get(`${enrollmentsOf(mine)}/${theirs.enrollmentId}`), owner);

            expect([res.status, res.body.code]).toEqual([404, "signing-enrollment-unknown"]);
        });

        it("still fail with the provider's own error when signing certificates are off (not an unknown id)", async () => {
            const mailbox = await ctx.createMailbox(owner.uid);
            SwitchableEnrollment.target = new NullSigningCertificateEnrollment();

            const res = await as(request(ctx.app()).get(`${enrollmentsOf(mailbox)}/x`), owner);
            const cancel = await as(request(ctx.app()).delete(`${enrollmentsOf(mailbox)}/x`), owner);

            expect(res.status).toBe(500);
            expect(cancel.status).toBe(500);
        });

        it("cancel a request idempotently: a stale id is answered as cancelled, so the client clears it and offers a new request", async () => {
            const stale = await requestCertificate();
            SwitchableEnrollment.target = ctx.newAutomatic();

            const first = await as(request(ctx.app()).delete(`${enrollmentsOf(stale.mailbox)}/${stale.enrollmentId}`), owner);
            const second = await as(request(ctx.app()).delete(`${enrollmentsOf(stale.mailbox)}/${stale.enrollmentId}`), owner);

            for (const res of [first, second]) {
                expect(res.status).toBe(200);
                expect(res.body).toEqual(
                    expect.objectContaining({ provider: "rfc8823", status: "failed", stage: "failed", errorCode: "cancelled", retryable: true, stages: [], progress: 0, error: "This request no longer exists." }),
                );
            }
        });

        it("refuse to cancel another mailbox's request, which is not an unknown one", async () => {
            const theirs = await requestCertificate();
            const mine = await ctx.createMailbox(owner.uid);

            const res = await as(request(ctx.app()).delete(`${enrollmentsOf(mine)}/${theirs.enrollmentId}`), owner);

            expect([res.status, res.body.code]).toEqual([404, "signing-enrollment-unknown"]);
            expect((await manual.checkStatus(theirs.enrollmentId)).status).toBe("pending");
        });

        it("still cancel a real request, and keep cancelling owner-only", async () => {
            const { mailbox, enrollmentId } = await requestCertificate();

            expect((await as(request(ctx.app()).delete(`${enrollmentsOf(mailbox)}/${enrollmentId}`), stranger)).status).toBe(403);
            const res = await as(request(ctx.app()).delete(`${enrollmentsOf(mailbox)}/${enrollmentId}`), owner);

            expect(res.body).toEqual(expect.objectContaining({ provider: "manual", status: "failed", errorCode: "cancelled", error: "Cancelled by the mailbox owner." }));
        });

        it("cannot cancel where the provider has no cancel", async () => {
            const mailbox = await ctx.createMailbox(owner.uid);
            SwitchableEnrollment.target = { name: "custom", describeEnrollment: async () => ({ identity: mailbox.primarySmtpAddress }) };

            expect((await as(request(ctx.app()).delete(`${enrollmentsOf(mailbox)}/any`), owner)).status).toBe(404);
        });
    });
}
