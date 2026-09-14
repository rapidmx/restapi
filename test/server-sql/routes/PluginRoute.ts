///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import { PluginRouteSQL } from "../../../src/routes/sql/PluginRouteSQL.js";
import { NpmRegistryClient } from "../../../src/plugins/NpmRegistryClient.js";
import { PluginInstanceStatus } from "../../../src/plugins/PluginUtils.js";
import { FakeRegistryClient, instanceStatuses, publishedHashes } from "../../plugins/pluginTestDoubles.js";
const { Route } = RouteDecorators;

@Route("/sql/plugins")
export class PluginRoute extends PluginRouteSQL {
    protected createRegistryClient(): NpmRegistryClient {
        return new FakeRegistryClient();
    }

    protected async publishChange(hash: string): Promise<void> {
        publishedHashes.push(hash);
    }

    protected async readInstanceStatuses(): Promise<PluginInstanceStatus[]> {
        return [...instanceStatuses];
    }
}
