///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// RspamdSpamScanProvider.learn() against a real local HTTP server standing in for rspamd's controller - the request on the wire.
import * as http from "http";
import type { AddressInfo } from "net";
import { RspamdSpamScanProvider } from "../../src/scan/RspamdSpamScanProvider.js";

interface Seen {
    method?: string;
    url?: string;
    headers: http.IncomingHttpHeaders;
    body: Buffer;
}

describe("RspamdSpamScanProvider.learn() on the wire Tests", () => {
    let server: http.Server;
    let seen: Seen[];
    let status: number;
    let controllerUrl: string;

    beforeEach(async () => {
        seen = [];
        status = 200;
        server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (chunk) => chunks.push(chunk));
            req.on("end", () => {
                seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
                res.statusCode = status;
                res.end(JSON.stringify({ success: status < 300 }));
            });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        controllerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const provider = (): RspamdSpamScanProvider => {
        const learner: any = new RspamdSpamScanProvider();
        learner.controllerUrl = controllerUrl;
        learner.controllerPassword = "controller-secret";
        return learner;
    };

    it("Sends the message bytes to /learnspam with the Password and Deliver-To headers.", async () => {
        const raw = Buffer.from("From: a@x.example\r\n\r\nbinary \u0000ÿ body");

        await provider().learn(raw, "spam", { recipient: "me@example.com" });

        expect(seen).toHaveLength(1);
        expect(seen[0].method).toBe("POST");
        expect(seen[0].url).toBe("/learnspam");
        expect(seen[0].headers["password"]).toBe("controller-secret");
        expect(seen[0].headers["deliver-to"]).toBe("me@example.com");
        expect(seen[0].headers["content-type"]).toBe("application/octet-stream");
        expect(seen[0].body.equals(raw)).toBe(true);
    });

    it("Sends ham to /learnham.", async () => {
        await provider().learn(Buffer.from("x"), "ham");

        expect(seen[0].url).toBe("/learnham");
        expect(seen[0].headers["deliver-to"]).toBeUndefined();
    });

    it("Treats rspamd's 208 (already learned) as learned, and a 403 (wrong password) as a failure.", async () => {
        status = 208;
        await expect(provider().learn(Buffer.from("x"), "spam")).resolves.toBeUndefined();

        status = 403;
        await expect(provider().learn(Buffer.from("x"), "spam")).rejects.toThrow("rspamd controller returned HTTP 403");
    });
});
