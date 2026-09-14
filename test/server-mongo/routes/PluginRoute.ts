///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import { PluginRouteMongo } from "../../../src/routes/mongo/PluginRouteMongo.js";
import { NpmRegistryClient } from "../../../src/plugins/NpmRegistryClient.js";
import { PluginInstanceStatus } from "../../../src/plugins/PluginUtils.js";
import { FakeRegistryClient, instanceStatuses, publishedHashes, registryClientRequests } from "../../plugins/pluginTestDoubles.js";
const { Route } = RouteDecorators;

@Route("/mongo/plugins")
export class PluginRoute extends PluginRouteMongo {
    protected createRegistryClient(packageOrNamespace?: string): NpmRegistryClient {
        registryClientRequests.push(packageOrNamespace);
        return new FakeRegistryClient();
    }

    protected async publishChange(hash: string): Promise<void> {
        publishedHashes.push(hash);
    }

    protected async readInstanceStatuses(): Promise<PluginInstanceStatus[]> {
        return [...instanceStatuses];
    }
}
