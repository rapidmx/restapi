///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import type { ObjectFactory } from "@rapidrest/service-core";
import type { ConfigCipher } from "./ConfigCipher.js";
import { configKeyCopyId, resolveConfigKeyChannel, type ConfigKeyChannel, type ConfigKeyHeartbeatEntry } from "./ConfigKeyChannel.js";
const { Config, Destroy, Init, Inject, Logger } = ObjectDecorators;

/** How often a copy reports, in seconds, when `config_encryption:activation:heartbeat_seconds` doesn't say (spec 5.5). */
export const DEFAULT_CONFIG_KEY_HEARTBEAT_SECONDS = 30;

/** A heartbeat outlives this many missed beats before its copy counts as gone. */
const HEARTBEATS_TO_LIVE = 3;

/**
 * Tells the other server copies which keys this process has loaded and which one it encrypts with (spec 5.5, step 2): every
 * `config_encryption:activation:heartbeat_seconds` (30), with a TTL of three of them, and at once after each keyring reload that changed something and when a
 * rotation notice arrives (which also makes the cipher re-read the keyring). A rotation activates its new key only when every live heartbeat lists it, and
 * re-encrypts only when every one reports encrypting with it, so no copy writes what another can't read. A copy that stops drops out when its heartbeat
 * expires.
 *
 * The server builds one at startup with `objectFactory.newInstance(ConfigKeyHeartbeat, { name: "default" })`. Reporting never throws: a failure is logged once
 * per distinct message and the next beat tries again.
 *
 * @author Jean-Philippe Steinmetz
 */
export class ConfigKeyHeartbeat {
    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    @Inject("ConfigCipher")
    protected cipher?: ConfigCipher;

    @Config("config_encryption:activation:heartbeat_seconds", DEFAULT_CONFIG_KEY_HEARTBEAT_SECONDS)
    protected heartbeatSeconds: unknown = DEFAULT_CONFIG_KEY_HEARTBEAT_SECONDS;

    @Logger
    protected logger: any;

    protected channel?: ConfigKeyChannel;

    private timer?: NodeJS.Timeout;
    private unsubscribeCipher?: () => void;
    private unsubscribeNotice?: () => Promise<void>;
    private lastError?: string;

    private intervalMs(): number {
        const seconds: number = Number(this.heartbeatSeconds);
        return (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_CONFIG_KEY_HEARTBEAT_SECONDS) * 1000;
    }

    @Init
    public async init(): Promise<void> {
        if (!this.cipher) {
            // Nothing to report without a keyring: the production key guard is the server's to enforce.
            return;
        }
        this.channel ??= await resolveConfigKeyChannel(this._objectFactory, this.logger);
        if (!this.channel) {
            // Production without a registered channel: there is no one to report to, and rotation is unavailable (said by the resolver).
            return;
        }
        this.unsubscribeCipher = this.cipher.onChange(() => void this.beat());
        this.unsubscribeNotice = await this.channel
            .onChanged(() => void this.reloadAndBeat())
            .catch((err: any) => {
                this.logger?.warn(`ConfigKeyHeartbeat: the rotation notice can't be heard (${err?.message}); the keyring is re-read every minute instead.`);
                return undefined;
            });
        await this.beat();
        this.timer = setInterval(() => void this.beat(), this.intervalMs());
        this.timer.unref();
    }

    /** Stops reporting and listening. Also run by the ObjectFactory when it destroys this instance. */
    @Destroy
    public async dispose(): Promise<void> {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        this.unsubscribeCipher?.();
        this.unsubscribeCipher = undefined;
        const stop: (() => Promise<void>) | undefined = this.unsubscribeNotice;
        this.unsubscribeNotice = undefined;
        await stop?.().catch(() => undefined);
    }

    /** What a rotation notice does: the cipher re-reads the keyring and the active kid, and what it has now is reported. */
    private async reloadAndBeat(): Promise<void> {
        await this.cipher!.reload();
        await this.beat();
    }

    /** Reports what this process has loaded now. Never throws. */
    public async beat(): Promise<void> {
        const entry: ConfigKeyHeartbeatEntry = {
            copy: configKeyCopyId(),
            kids: this.cipher!.loadedKids(),
            ...(this.cipher!.currentKid() !== undefined ? { encrypting: this.cipher!.currentKid() } : {}),
            at: new Date().toISOString(),
        };
        try {
            await this.channel!.putHeartbeat(entry, this.intervalMs() * HEARTBEATS_TO_LIVE);
            this.lastError = undefined;
        } catch (err: any) {
            if (err?.message !== this.lastError) {
                this.lastError = err?.message;
                this.logger?.warn(`ConfigKeyHeartbeat: the keyring heartbeat can't be written (${err?.message}); a rotation waits for it.`);
            }
        }
    }
}
