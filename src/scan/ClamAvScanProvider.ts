///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as net from "net";
import { ObjectDecorators } from "@rapidrest/core";
import { AvVerdict } from "../models/types.js";
import { AvScanProvider, AvScanResult } from "./AvScanProvider.js";
const { Config, Logger } = ObjectDecorators;

/** The maximum size, in bytes, of a single chunk sent per the INSTREAM protocol's chunk-length prefix. */
const CHUNK_SIZE = 64 * 1024;

/**
 * `AvScanProvider` adapter for ClamAV, talking to `clamd` via the INSTREAM protocol (a length-prefixed chunk
 * stream over a TCP or Unix socket) — chosen over shelling out to the `clamscan` CLI so scanning doesn't incur
 * a process-spawn per call and works transparently against a remote `clamd` instance.
 *
 * @author Jean-Philippe Steinmetz
 */
export class ClamAvScanProvider implements AvScanProvider {
    public readonly name: string = "clamav";

    @Config("mail:scan:av:clamav:host", "127.0.0.1")
    private host: string = "127.0.0.1";

    @Config("mail:scan:av:clamav:port", 3310)
    private port: number = 3310;

    @Config("mail:scan:av:clamav:timeout_ms", 30_000)
    private timeoutMs: number = 30_000;

    @Logger
    private logger: any;

    public async scanBuffer(content: Buffer, filename?: string): Promise<AvScanResult> {
        try {
            const reply: string = await this.instream(content);
            return parseReply(reply);
        } catch (err: any) {
            // A scan-engine outage must not silently pass content through as clean — fail closed to `ERROR`
            // so the caller's verdict-routing treats it the same as an infected result (quarantine), not clean.
            this.logger?.error(`ClamAV scan failed for '${filename ?? "(unnamed)"}': ${err.message}`);
            return { verdict: AvVerdict.ERROR };
        }
    }

    private instream(content: Buffer): Promise<string> {
        return new Promise((resolve, reject) => {
            const socket = net.createConnection({ host: this.host, port: this.port });
            const chunks: Buffer[] = [];
            let settled = false;

            const finish = (err?: Error, result?: string) => {
                if (settled) {
                    return;
                }
                settled = true;
                socket.destroy();
                if (err) {
                    reject(err);
                } else {
                    resolve(result!);
                }
            };

            socket.setTimeout(this.timeoutMs, () => finish(new Error("clamd connection timed out")));
            socket.on("error", (err) => finish(err));
            socket.on("data", (data: Buffer) => chunks.push(data));
            socket.on("end", () => finish(undefined, Buffer.concat(chunks).toString("utf-8").replace(/\0$/, "")));

            socket.on("connect", () => {
                socket.write("zINSTREAM\0");
                for (let offset = 0; offset < content.length; offset += CHUNK_SIZE) {
                    const chunk: Buffer = content.subarray(offset, Math.min(offset + CHUNK_SIZE, content.length));
                    const lengthPrefix = Buffer.alloc(4);
                    lengthPrefix.writeUInt32BE(chunk.length, 0);
                    socket.write(lengthPrefix);
                    socket.write(chunk);
                }
                // A zero-length chunk terminates the stream per the INSTREAM protocol.
                const terminator = Buffer.alloc(4);
                terminator.writeUInt32BE(0, 0);
                socket.write(terminator);
            });
        });
    }
}

/** Parses a clamd INSTREAM reply, e.g. `"stream: OK"` or `"stream: Eicar-Test-Signature FOUND"`. */
function parseReply(reply: string): AvScanResult {
    const match = reply.match(/:\s*(.+?)\s+FOUND$/);
    if (match) {
        return { verdict: AvVerdict.INFECTED, signatureName: match[1] };
    }
    if (reply.includes("ERROR")) {
        return { verdict: AvVerdict.ERROR };
    }
    return { verdict: AvVerdict.CLEAN };
}
