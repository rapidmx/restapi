///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The signing-certificate enrollment's status and progress through the key-vault routes, identical on both backends:
// `GET .../sign-enrollment/:enrollmentId` (status + stages + progress), `GET .../sign-enrollment` (the mailbox's current
// enrollment) and `POST .../sign-enrollment/:enrollmentId/check` (check now, rate limited). The real
// `Rfc8823AcmeSigningCertificateEnrollment` runs against a fake ACME client (`test/pki/acmeTestDoubles.ts`), its state on
// disk, so every stage is real. `test/routes/{mongo,sql}/KeyVaultRoute.SignEnrollmentProgress.test.ts` supply the server.
import * as fs from "fs/promises";
import * as path from "path";
import { request } from "@rapidrest/service-core/test";
import * as uuid from "uuid";
import { FakeAcmeClient, generateCsr, generateSelfSignedCertificate, type TestEnrollment } from "../pki/acmeTestDoubles.js";
import type { RecordingMailTransport } from "../testDoubles.js";

export interface SignEnrollmentProgressSuiteContext {
    app: () => any;
    /** e.g. `/mongo/mailboxes`. */
    baseUrl: string;
    tokenFor: (user: any) => string;
    /** A mailbox owned by `ownerUid` (FULL for it) plus explicit `grants` for other users. */
    createMailbox: (ownerUid: string | undefined, grants?: Array<{ userUid: string; actions: string[] }>) => Promise<any>;
    /** The `SigningCertificateEnrollment` the server injects: a `TestEnrollment` on a temporary store. */
    enrollment: () => TestEnrollment;
    transport: () => RecordingMailTransport;
}

const WRAPPED_KEY = { ciphertext: "ct", nonce: "n", algorithm: "AES-256-GCM" };

export function signEnrollmentProgressSuite(ctx: SignEnrollmentProgressSuiteContext): void {
    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const delegate: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const stranger: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const tokens = {
        owner: ctx.tokenFor(owner),
        delegate: ctx.tokenFor(delegate),
        stranger: ctx.tokenFor(stranger),
        admin: ctx.tokenFor(admin),
    };
    const as = (req: any, token: string) => req.set("Authorization", "jwt " + token);
    const base = (mailboxUid: string) => `${ctx.baseUrl}/${mailboxUid}/keyvault/keys/sign-enrollment`;

    const mailboxFor = () => ctx.createMailbox(owner.uid, [{ userUid: delegate.uid, actions: ["read"] }]);
    const start = async (mailbox: any, token: string = tokens.owner): Promise<string> => {
        const res = await as(request(ctx.app()).post(base(mailbox.uid)), token).send({
            csr: await generateCsr(mailbox.primarySmtpAddress),
            wrappedKey: WRAPPED_KEY,
        });
        expect(res.status).toBe(200);
        return res.body.enrollmentId;
    };
    const status = (mailbox: any, id: string, token: string = tokens.owner) => as(request(ctx.app()).get(`${base(mailbox.uid)}/${id}`), token);
    const current = (mailbox: any, token: string = tokens.owner) => as(request(ctx.app()).get(base(mailbox.uid)), token);
    const check = (mailbox: any, id: string, token: string = tokens.owner) => as(request(ctx.app()).post(`${base(mailbox.uid)}/${id}/check`), token);
    const receiveChallenge = (id: string) =>
        ctx.enrollment().recordChallengeToken(id, "token-part-1", "reply-to@acme.test", "<challenge@acme.test>", "ACME: token-part-1");
    /** Lets the next check through: the limit is one check per enrollment per ~10 s, and a test can't wait that long. */
    const releaseCheckLimit = async (id: string): Promise<void> => {
        const file = path.join((ctx.enrollment() as any).storeDir, "enrollments.json");
        const store = JSON.parse(await fs.readFile(file, "utf-8"));
        delete store[id].lastForcedCheckAt;
        await fs.writeFile(file, JSON.stringify(store));
    };
    const states = (body: any): string[] => body.stages.map((stage: any) => `${stage.id}:${stage.state}`);

    beforeEach(() => {
        FakeAcmeClient.reset();
        ctx.transport().sent = [];
    });

    describe("GET .../sign-enrollment/:enrollmentId", () => {
        it("keeps status, certificate and error, and adds the stage, the stage list, the progress and the times", async () => {
            const mailbox = await mailboxFor();
            const id = await start(mailbox);

            const res = await status(mailbox, id);

            expect(res.status).toBe(200);
            expect(res.body).toEqual(
                expect.objectContaining({
                    status: "pending",
                    stage: "awaiting-challenge",
                    progress: 15,
                    requestedAt: expect.any(String),
                    updatedAt: expect.any(String),
                    nextCheckAt: expect.any(String),
                }),
            );
            expect(res.body.certificate).toBeUndefined();
            expect(res.body.error).toBeUndefined();
            expect(states(res.body)).toEqual([
                "submitted:done",
                "awaiting-challenge:active",
                "challenge-answered:pending",
                "validating:pending",
                "issuing:pending",
                "issued:pending",
            ]);
            expect(res.body.stages.map((stage: any) => stage.label)).toEqual([
                "Request submitted",
                "Verification e-mail sent by the CA",
                "Verification e-mail answered",
                "CA validating",
                "Certificate being issued",
                "Certificate issued",
            ]);
        });

        it("lets a delegate with READ see it, and nobody else", async () => {
            const mailbox = await mailboxFor();
            const id = await start(mailbox);

            expect((await status(mailbox, id, tokens.delegate)).status).toBe(200);
            expect((await status(mailbox, id, tokens.stranger)).status).toBe(403);
            expect((await status(mailbox, id, tokens.admin)).status).toBe(403);
        });

        it("answers 404 for an enrollment of another mailbox", async () => {
            const mine = await mailboxFor();
            const theirs = await ctx.createMailbox(owner.uid);
            const id = await start(theirs);

            expect((await status(mine, id)).status).toBe(404);
            expect((await check(mine, id)).status).toBe(404);
            expect((await status(mine, "no-such-enrollment")).status).toBe(404);
        });
    });

    describe("GET .../sign-enrollment (the mailbox's current enrollment)", () => {
        it("answers 404 when the mailbox never enrolled", async () => {
            expect((await current(await mailboxFor())).status).toBe(404);
        });

        it("finds an enrollment its client never saw start, in the same shape plus its id", async () => {
            const mailbox = await mailboxFor();
            const id = await start(mailbox);

            const res = await current(mailbox);

            expect(res.status).toBe(200);
            expect(res.body.enrollmentId).toBe(id);
            expect(res.body).toEqual({ ...(await status(mailbox, id)).body, enrollmentId: id });
        });

        it("prefers the one still in flight over an older or newer finished one", async () => {
            const mailbox = await mailboxFor();
            const cancelled = await start(mailbox);
            await as(request(ctx.app()).delete(`${base(mailbox.uid)}/${cancelled}`), tokens.owner);
            await new Promise((resolve) => setTimeout(resolve, 5));
            const inFlight = await start(mailbox);
            await new Promise((resolve) => setTimeout(resolve, 5));
            const cancelledLater = await start(mailbox);
            await as(request(ctx.app()).delete(`${base(mailbox.uid)}/${cancelledLater}`), tokens.owner);

            const res = await current(mailbox);

            expect(res.body.enrollmentId).toBe(inFlight);
            expect(res.body.status).toBe("pending");
        });

        it("falls back to the most recent one when none is in flight", async () => {
            const mailbox = await mailboxFor();
            const older = await start(mailbox);
            await as(request(ctx.app()).delete(`${base(mailbox.uid)}/${older}`), tokens.owner);
            await new Promise((resolve) => setTimeout(resolve, 5));
            const newer = await start(mailbox);
            await as(request(ctx.app()).delete(`${base(mailbox.uid)}/${newer}`), tokens.owner);

            const res = await current(mailbox);

            expect(res.body.enrollmentId).toBe(newer);
            expect(res.body).toEqual(expect.objectContaining({ status: "failed", stage: "failed", errorCode: "cancelled", retryable: true }));
        });

        it("keeps offering an issued certificate the job hasn't installed yet, and never another mailbox's enrollment", async () => {
            const mailbox = await mailboxFor();
            const other = await ctx.createMailbox(owner.uid);
            await start(other);
            const id = await start(mailbox);
            await receiveChallenge(id);
            await ctx.enrollment().advanceEnrollment(id);
            FakeAcmeClient.orderStatus = "valid";
            FakeAcmeClient.certificatePem = await generateSelfSignedCertificate(mailbox.primarySmtpAddress);
            await ctx.enrollment().advanceEnrollment(id);

            const res = await current(mailbox);

            expect(res.body).toEqual(expect.objectContaining({ enrollmentId: id, status: "issued", stage: "issued", progress: 100 }));
            expect(res.body.installedAt).toBeUndefined();
        });

        it("lets a delegate with READ ask, and nobody else", async () => {
            const mailbox = await mailboxFor();
            await start(mailbox);

            expect((await current(mailbox, tokens.delegate)).status).toBe(200);
            expect((await current(mailbox, tokens.stranger)).status).toBe(403);
            expect((await current(mailbox, tokens.admin)).status).toBe(403);
        });
    });

    describe("POST .../sign-enrollment/:enrollmentId/check", () => {
        it("checks a request still waiting for the CA's e-mail: same shape, lastCheckedAt set", async () => {
            const mailbox = await mailboxFor();
            const id = await start(mailbox);

            const res = await check(mailbox, id);

            expect(res.status).toBe(200);
            expect(res.body).toEqual(expect.objectContaining({ status: "pending", stage: "awaiting-challenge", lastCheckedAt: expect.any(String) }));
            expect(Object.keys((await status(mailbox, id)).body).sort()).toEqual(expect.arrayContaining(Object.keys(res.body).filter((key) => key !== "note")));
        });

        it("walks an enrollment through every stage, one check at a time", async () => {
            const mailbox = await mailboxFor();
            const id = await start(mailbox);

            // The CA's verification e-mail arrives (mail ingest records it): the next check answers it and asks the CA.
            await receiveChallenge(id);
            let res = await check(mailbox, id);
            expect(res.body.stage).toBe("validating");
            expect(ctx.transport().sent).toHaveLength(1);
            expect(FakeAcmeClient.completeChallengeCallCount).toBe(1);
            expect(states(res.body).slice(0, 4)).toEqual(["submitted:done", "awaiting-challenge:done", "challenge-answered:done", "validating:active"]);

            // The CA validated the reply: the check finalizes the order.
            await releaseCheckLimit(id);
            FakeAcmeClient.orderStatus = "ready";
            res = await check(mailbox, id);
            expect(res.body.stage).toBe("issuing");
            expect(FakeAcmeClient.finalizeCallCount).toBe(1);

            // The CA issued it: the check downloads the certificate.
            await releaseCheckLimit(id);
            FakeAcmeClient.orderStatus = "valid";
            FakeAcmeClient.certificatePem = await generateSelfSignedCertificate(mailbox.primarySmtpAddress);
            res = await check(mailbox, id);
            expect(res.body).toEqual(
                expect.objectContaining({ status: "issued", stage: "issued", progress: 100, certificate: FakeAcmeClient.certificatePem }),
            );
            expect(res.body.notAfter).toBeTruthy();
            expect(res.body.serialNumber).toBe("0a1b2c");
            expect(res.body.subject).toBe(`CN=${mailbox.primarySmtpAddress}`);
            expect(res.body.issuedAt).toBeTruthy();
        });

        it("reports a CA that refused the request as failed and not retryable", async () => {
            const mailbox = await mailboxFor();
            const id = await start(mailbox);
            await receiveChallenge(id);
            await check(mailbox, id);
            await releaseCheckLimit(id);
            FakeAcmeClient.orderStatus = "invalid";
            FakeAcmeClient.orderError = { type: "urn:ietf:params:acme:error:rejectedIdentifier", detail: "not a mailbox we serve" };

            const res = await check(mailbox, id);

            expect(res.status).toBe(200);
            expect(res.body).toEqual(expect.objectContaining({ status: "failed", stage: "failed", errorCode: "rejected", retryable: false }));
            expect(res.body.error).toContain("not a mailbox we serve");
        });

        it("reports an unreachable CA in the answer instead of failing the request", async () => {
            const mailbox = await mailboxFor();
            const id = await start(mailbox);
            await receiveChallenge(id);
            await check(mailbox, id);
            await releaseCheckLimit(id);
            FakeAcmeClient.getOrderError = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });

            const res = await check(mailbox, id);

            expect(res.status).toBe(200);
            expect(res.body).toEqual(expect.objectContaining({ status: "pending", errorCode: "ca-unreachable", retryable: true, note: "connect ETIMEDOUT" }));
        });

        it("refuses a second check of the same enrollment within about ten seconds, with Retry-After - and only that enrollment", async () => {
            const mailbox = await mailboxFor();
            const id = await start(mailbox);
            const other = await start(mailbox);
            expect((await check(mailbox, id)).status).toBe(200);
            const calls = FakeAcmeClient.getOrderCallCount;

            const refused = await check(mailbox, id);

            expect(refused.status).toBe(429);
            const retryAfter = Number(refused.headers["retry-after"]);
            expect(retryAfter).toBeGreaterThanOrEqual(1);
            expect(retryAfter).toBeLessThanOrEqual(10);
            expect(FakeAcmeClient.getOrderCallCount).toBe(calls);
            expect((await check(mailbox, other)).status).toBe(200);
        });

        it("answers a finished enrollment as it is, as often as asked", async () => {
            const mailbox = await mailboxFor();
            const id = await start(mailbox);
            await as(request(ctx.app()).delete(`${base(mailbox.uid)}/${id}`), tokens.owner);

            const first = await check(mailbox, id);
            const second = await check(mailbox, id);

            expect(first.status).toBe(200);
            expect(first.body).toEqual(expect.objectContaining({ status: "failed", errorCode: "cancelled" }));
            expect(second.status).toBe(200);
            expect(FakeAcmeClient.getOrderCallCount).toBe(0);
        });

        it("lets a delegate with READ check, and nobody else", async () => {
            const mailbox = await mailboxFor();
            const id = await start(mailbox);

            expect((await check(mailbox, id, tokens.stranger)).status).toBe(403);
            expect((await check(mailbox, id, tokens.admin)).status).toBe(403);
            expect(FakeAcmeClient.getOrderCallCount).toBe(0);
            expect((await check(mailbox, id, tokens.delegate)).status).toBe(200);
        });

        it("answers 404 for an unknown enrollment and 403 for an unknown mailbox", async () => {
            const mailbox = await mailboxFor();

            expect((await check(mailbox, "no-such-enrollment")).status).toBe(404);
            expect((await as(request(ctx.app()).post(`${ctx.baseUrl}/${uuid.v4()}@example.com/keyvault/keys/sign-enrollment/x/check`), tokens.owner)).status).toBe(403);
        });
    });
}
