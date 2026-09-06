///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for ClamAvScanProvider - `node:net`'s `createConnection` is mocked to return a fake
// socket built on a real `EventEmitter` (so `.on()`/emit work naturally) plus `vi.fn()`s for the methods the
// INSTREAM protocol implementation calls directly (`write`/`destroy`/`setTimeout`). `parseReply()` is not
// exported, so its branches are exercised indirectly through `scanBuffer()`.
import { EventEmitter } from "events";

vi.mock("net", () => ({
    createConnection: vi.fn(),
}));

import * as net from "net";
import { ClamAvScanProvider } from "../../src/scan/ClamAvScanProvider.js";
import { AvVerdict } from "../../src/models/types.js";

const mockCreateConnection = net.createConnection as any;

/** A fake `net.Socket`: a real EventEmitter (for natural `.on()`/emit semantics) plus the methods used directly. */
function makeFakeSocket() {
    const socket: any = new EventEmitter();
    socket.write = vi.fn();
    socket.destroy = vi.fn();
    socket.setTimeout = vi.fn();
    return socket;
}

describe("ClamAvScanProvider Tests", () => {
    let provider: ClamAvScanProvider;
    let socket: ReturnType<typeof makeFakeSocket>;

    beforeEach(() => {
        provider = new ClamAvScanProvider();
        socket = makeFakeSocket();
        mockCreateConnection.mockReturnValue(socket);
    });

    /** Simulates the connect handshake completing so the INSTREAM write sequence runs. */
    function connect() {
        socket.emit("connect");
    }

    it("Connects using the configured host/port.", async () => {
        (provider as any).host = "clamav.internal";
        (provider as any).port = 3311;
        const promise = provider.scanBuffer(Buffer.from("content"));
        connect();
        socket.emit("end");

        await promise;

        expect(mockCreateConnection).toHaveBeenCalledWith({ host: "clamav.internal", port: 3311 });
    });

    it("Writes the INSTREAM greeting, chunked content, and zero-length terminator on connect.", async () => {
        const content = Buffer.from("hello");
        const promise = provider.scanBuffer(content);
        connect();
        socket.emit("data", Buffer.from("stream: OK\0"));
        socket.emit("end");

        await promise;

        expect(socket.write).toHaveBeenCalledWith("zINSTREAM\0");
        // Length-prefix (4 bytes) then the chunk itself, then a 4-byte zero terminator.
        const lengthPrefix = Buffer.alloc(4);
        lengthPrefix.writeUInt32BE(content.length, 0);
        expect(socket.write).toHaveBeenCalledWith(lengthPrefix);
        expect(socket.write).toHaveBeenCalledWith(content);
        const terminator = Buffer.alloc(4);
        terminator.writeUInt32BE(0, 0);
        expect(socket.write).toHaveBeenCalledWith(terminator);
    });

    it("Returns CLEAN for a clean 'stream: OK' reply.", async () => {
        const promise = provider.scanBuffer(Buffer.from("clean content"));
        connect();
        socket.emit("data", Buffer.from("stream: OK\0"));
        socket.emit("end");

        const result = await promise;

        expect(result).toEqual({ verdict: AvVerdict.CLEAN });
        expect(socket.destroy).toHaveBeenCalled();
    });

    it("Returns INFECTED with the matched signature name for a FOUND reply.", async () => {
        const promise = provider.scanBuffer(Buffer.from("eicar"));
        connect();
        socket.emit("data", Buffer.from("stream: Eicar-Test-Signature FOUND\0"));
        socket.emit("end");

        const result = await promise;

        expect(result).toEqual({ verdict: AvVerdict.INFECTED, signatureName: "Eicar-Test-Signature" });
    });

    it("Returns ERROR for a clamd ERROR reply.", async () => {
        const promise = provider.scanBuffer(Buffer.from("bad"));
        connect();
        socket.emit("data", Buffer.from("stream: INSTREAM size limit exceeded. ERROR\0"));
        socket.emit("end");

        const result = await promise;

        expect(result).toEqual({ verdict: AvVerdict.ERROR });
    });

    it("Reassembles a reply split across multiple 'data' events.", async () => {
        const promise = provider.scanBuffer(Buffer.from("split"));
        connect();
        socket.emit("data", Buffer.from("stream: "));
        socket.emit("data", Buffer.from("OK\0"));
        socket.emit("end");

        const result = await promise;

        expect(result).toEqual({ verdict: AvVerdict.CLEAN });
    });

    it("Fails closed to ERROR (not thrown) when the socket emits an 'error' event.", async () => {
        const promise = provider.scanBuffer(Buffer.from("x"));
        connect();
        socket.emit("error", new Error("ECONNREFUSED"));

        const result = await promise;

        expect(result).toEqual({ verdict: AvVerdict.ERROR });
        expect(socket.destroy).toHaveBeenCalled();
    });

    it("Fails closed to ERROR (not thrown) on a connection timeout.", async () => {
        socket.setTimeout.mockImplementation((_ms: number, cb: () => void) => {
            // Simulate clamd never responding: invoke the timeout callback directly.
            cb();
        });

        const promise = provider.scanBuffer(Buffer.from("x"));
        connect();

        const result = await promise;

        expect(result).toEqual({ verdict: AvVerdict.ERROR });
    });

    it("Ignores a second settle attempt after the first (e.g. error after timeout already fired).", async () => {
        socket.setTimeout.mockImplementation((_ms: number, cb: () => void) => {
            cb();
        });

        const promise = provider.scanBuffer(Buffer.from("x"));
        connect();
        // A late 'error' after timeout already resolved must not throw/reject a second time.
        socket.emit("error", new Error("late error"));

        const result = await promise;

        expect(result).toEqual({ verdict: AvVerdict.ERROR });
    });

    it("Includes the filename in the logged error message when the scan fails.", async () => {
        const error = vi.fn();
        (provider as any).logger = { error };
        const promise = provider.scanBuffer(Buffer.from("x"), "malware.exe");
        connect();
        socket.emit("error", new Error("boom"));

        await promise;

        expect(error).toHaveBeenCalledWith(expect.stringContaining("malware.exe"));
        expect(error).toHaveBeenCalledWith(expect.stringContaining("boom"));
    });

    it("Falls back to '(unnamed)' in the logged error message when no filename is provided.", async () => {
        const error = vi.fn();
        (provider as any).logger = { error };
        const promise = provider.scanBuffer(Buffer.from("x"));
        connect();
        socket.emit("error", new Error("boom"));

        await promise;

        expect(error).toHaveBeenCalledWith(expect.stringContaining("(unnamed)"));
    });

    it("Chunks content larger than 64KB into multiple length-prefixed writes.", async () => {
        const content = Buffer.alloc(64 * 1024 + 100, "a");
        const promise = provider.scanBuffer(content);
        connect();
        socket.emit("data", Buffer.from("stream: OK\0"));
        socket.emit("end");

        await promise;

        // greeting + 2 chunks * (length-prefix + chunk) + terminator = 6 write calls.
        expect(socket.write).toHaveBeenCalledTimes(6);
    });
});
