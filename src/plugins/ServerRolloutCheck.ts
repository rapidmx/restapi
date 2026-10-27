///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** What `ServerRolloutCheck.check()` found. */
export interface RolloutStatus {
    /** Whether every server copy runs this release, so none can still apply a plugin's settings raw and hand a plugin an envelope as a value. */
    rolledOut: boolean;
    /** Why it isn't (pods of an older release, by name, or pods that can't be listed): what `ConfigKeyState.pluginSecrets.reason` records for the console and
     * Diagnostics. Never a secret. */
    reason?: string;
}

/**
 * Whether the server's rolling upgrade has finished (spec 5.7): `PluginSecretEncryptor` encrypts plugin secret settings only once no server copy of the
 * previous release is left, since such a copy applies `Plugin.settings` raw and would hand a plugin an envelope as a setting's value. The server registers
 * `KubePodRolloutCheck` under the DI token `"ServerRolloutCheck"` (every pod matching the server Deployment's selector carries its own pod's
 * `pod-template-hash`, through the read-only pods access the Diagnostics Role already grants); a deployment outside Kubernetes (`yarn dev`,
 * docker-compose) that registers none uses `NullServerRolloutCheck`, since there is no rolling upgrade there.
 */
export interface ServerRolloutCheck {
    /** Answers whether the rollout has finished. May reject when it can't tell (the pods can't be listed): the caller waits, as for an unfinished rollout. */
    check(): Promise<RolloutStatus>;
}

/** The default `ServerRolloutCheck`: there is no rollout to wait for. */
export class NullServerRolloutCheck implements ServerRolloutCheck {
    public async check(): Promise<RolloutStatus> {
        return { rolledOut: true };
    }
}

/** A `ServerRolloutCheck` that can't tell, so `PluginSecretEncryptor` waits: what stands in for a check that is registered but broken, or that is missing where it must not be. */
export class UnavailableServerRolloutCheck implements ServerRolloutCheck {
    /** @param message Why it can't tell: what the encryptor logs. Never a secret. */
    constructor(private readonly message: string) {}

    public async check(): Promise<RolloutStatus> {
        throw new Error(this.message);
    }
}

/** What `ObjectFactory.newInstance()` throws for a class nobody registered. */
const NOT_REGISTERED = /^No class found with name/;

/**
 * The `ServerRolloutCheck` registered under `"ServerRolloutCheck"`. `NullServerRolloutCheck` ("rolled out") is the answer only for a server that registers none
 * and doesn't run in Kubernetes. A registered class that fails to build or start (a Kubernetes API error, a token not yet mounted) or a Kubernetes server with
 * none registered gets `UnavailableServerRolloutCheck` instead, so the encryptor waits rather than encrypt while pods of an older release may still be running
 * (`config_encryption:plugin_secrets:wait_for_rollout: false` is the operator's way past it).
 *
 * @param objectFactory What resolves the registered class.
 * @param logger Where a check that can't be built is reported.
 * @param env The process environment: `KUBERNETES_SERVICE_HOST` tells a pod from a machine with no rolling upgrade.
 */
export async function resolveServerRolloutCheck(
    objectFactory: { newInstance: (type: any, options?: any) => Promise<any> } | undefined,
    logger?: any,
    env: NodeJS.ProcessEnv = process.env,
): Promise<ServerRolloutCheck> {
    try {
        const check: ServerRolloutCheck | undefined = objectFactory ? await objectFactory.newInstance("ServerRolloutCheck", { name: "default" }) : undefined;
        if (check) {
            return check;
        }
    } catch (err: any) {
        if (!NOT_REGISTERED.test(String(err?.message))) {
            const message = `The registered ServerRolloutCheck could not be built: ${err?.message}`;
            logger?.error(`PluginSecretEncryptor: ${message}; the plugin secret settings wait.`);
            return new UnavailableServerRolloutCheck(message);
        }
    }
    if (env.KUBERNETES_SERVICE_HOST) {
        const message = "No ServerRolloutCheck is registered on a server running in Kubernetes, so the rollout can't be checked";
        logger?.warn(`PluginSecretEncryptor: ${message}; the plugin secret settings wait (config_encryption:plugin_secrets:wait_for_rollout: false skips the check).`);
        return new UnavailableServerRolloutCheck(`${message}; config_encryption:plugin_secrets:wait_for_rollout: false skips the check.`);
    }
    return new NullServerRolloutCheck();
}
