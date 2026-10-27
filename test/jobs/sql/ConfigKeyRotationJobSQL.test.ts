///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for ConfigKeyRotationJobSQL: a real SQLite connection and a real `ObjectFactory` construct the job exactly as production
// wiring would, with a real `ConfigCipherSQL` reading a keyring file. The phases themselves are in ../configKeyRotationSuite.ts, shared with the Mongo
// backend; on SQL the rotation's dates come back as text from its JSON column, which the job and the suite read the same way.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ACLUtils, AccessControlListSQL, ConnectionManager, ObjectFactory, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import config from "../../config.sql.js";
import { ConfigKeyRotationJobSQL } from "../../../src/jobs/sql/ConfigKeyRotationJobSQL.js";
import { AuditLogEntrySQL } from "../../../src/models/sql/AuditLogEntrySQL.js";
import { ConfigKeyStateSQL } from "../../../src/models/sql/ConfigKeyStateSQL.js";
import { DnsProviderSQL } from "../../../src/models/sql/DnsProviderSQL.js";
import { IntegrationSettingsSQL } from "../../../src/models/sql/IntegrationSettingsSQL.js";
import { PluginSQL } from "../../../src/models/sql/PluginSQL.js";
import { AuditAction } from "../../../src/models/types.js";
import { LocalConfigKeyChannel } from "../../../src/secrets/ConfigKeyChannel.js";
import { ConfigCipherSQL } from "../../../src/util/sql/ConfigCipherSQL.js";
import { configKeyRotationSuite } from "../configKeyRotationSuite.js";

describe("ConfigKeyRotationJobSQL Tests (real DB + DI)", () => {
    const logger = Logger();
    const dir: string = fs.mkdtempSync(path.join(os.tmpdir(), "config-key-rotation-sql-"));
    const keyringFile: string = path.join(dir, "keyring.json");
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    const repos: Record<string, Repository<any>> = {};

    const clearAll = async (): Promise<void> => {
        for (const repo of Object.values(repos)) {
            await repo.clear();
        }
    };

    beforeAll(async () => {
        fs.writeFileSync(keyringFile, "");
        config.set("config_encryption:keyring_file", keyringFile);
        objectFactory = new ObjectFactory(config, logger);
        // Normally registered by `Server`'s own bootstrap - registered explicitly here since this file bypasses `Server`.
        objectFactory.register(ACLUtils);
        objectFactory.register(ConfigCipherSQL, "ConfigCipher");
        objectFactory.register(LocalConfigKeyChannel, "ConfigKeyChannel");

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("AccessControlListSQL", AccessControlListSQL);
        for (const cls of [ConfigKeyStateSQL, DnsProviderSQL, IntegrationSettingsSQL, PluginSQL, AuditLogEntrySQL]) {
            models.set(cls.name, cls);
        }
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("sql");
        if (!isSqlDataSource(conn)) {
            throw new Error("Could not find sql connection");
        }
        for (const cls of [ConfigKeyStateSQL, DnsProviderSQL, IntegrationSettingsSQL, PluginSQL, AuditLogEntrySQL]) {
            repos[cls.name] = conn.getRepository(cls);
        }
        // What the job injects, built once so the suite can reach them.
        await objectFactory.newInstance("ConfigCipher", { name: "default" });
        await objectFactory.newInstance("ConfigKeyChannel", { name: "default" });
    });

    afterAll(async () => {
        // The database file is shared with later SQL suites, which must not find these rows.
        await clearAll();
        await objectFactory.destroy();
        config.set("config_encryption:keyring_file", "");
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("Resolves the registered ConfigCipher and ConfigKeyChannel, and builds its repositories.", async () => {
        const job: any = await objectFactory.newInstance(ConfigKeyRotationJobSQL, { name: "default" });
        expect(job.cipher).toBeInstanceOf(ConfigCipherSQL);
        expect(job.channel).toBeInstanceOf(LocalConfigKeyChannel);
        expect(job.stateRepo).toBeDefined();
        expect(job.auditLogUtils).toBeDefined();
        // The record types that hold envelopes: a DNS provider's credentials and the Integrations settings' secrets.
        expect(job.sources.list().map((source: any) => [source.record, source.modelClass])).toEqual([
            ["DnsProvider", DnsProviderSQL],
            ["IntegrationSettings", IntegrationSettingsSQL],
        ]);
        await job.dispose();
    });

    configKeyRotationSuite({
        newJob: async () => await objectFactory.newInstance(ConfigKeyRotationJobSQL, { name: `replica-${uuid.v4()}` }),
        cipher: () => objectFactory.getInstance<any>("ConfigCipher")!,
        channel: () => objectFactory.getInstance<any>("ConfigKeyChannel")!,
        keyringFile: () => keyringFile,
        saveState: async (fields) => {
            await repos.ConfigKeyStateSQL.delete({ uid: fields.uid } as any);
            await repos.ConfigKeyStateSQL.save(new ConfigKeyStateSQL(fields as any));
        },
        state: async () => (await repos.ConfigKeyStateSQL.findOne({ where: { uid: "config-keys" } })) ?? undefined,
        clearState: async () => await repos.ConfigKeyStateSQL.clear(),
        insertPlugin: async (uid, settings) => {
            await repos.PluginSQL.save(new PluginSQL({ uid, name: `@rapidmx/${uid}`, packageVersion: "1.0.0", enabled: true, settings: settings as any } as any));
        },
        plugin: async (uid) => (await repos.PluginSQL.findOne({ where: { uid } }))!,
        touchPlugin: async (uid, note) => {
            const row = (await repos.PluginSQL.findOne({ where: { uid } }))!;
            await repos.PluginSQL.update({ uid }, { settings: { ...row.settings, note } });
            await repos.PluginSQL.increment({ uid }, "version", 1);
        },
        deletePlugin: async (uid) => {
            await repos.PluginSQL.delete({ uid });
        },
        clearPlugins: async () => await repos.PluginSQL.clear(),
        pluginModel: () => PluginSQL,
        insertProvider: async (uid, credentials, credentialsGeneration) => {
            await repos.DnsProviderSQL.save(
                new DnsProviderSQL({ uid, name: `provider ${uid}`, type: "route53", zones: ["example.com"], options: { region: "us-east-1" }, credentials, credentialsGeneration } as any),
            );
        },
        provider: async (uid) => (await repos.DnsProviderSQL.findOne({ where: { uid } }))!,
        clearProviders: async () => await repos.DnsProviderSQL.clear(),
        providerModel: () => DnsProviderSQL,
        insertIntegrations: async (sections) => {
            await repos.IntegrationSettingsSQL.save(new IntegrationSettingsSQL({ uid: "integrations", ...sections } as any));
        },
        integrations: async () => (await repos.IntegrationSettingsSQL.findOne({ where: { uid: "integrations" } }))!,
        clearIntegrations: async () => await repos.IntegrationSettingsSQL.clear(),
        integrationsModel: () => IntegrationSettingsSQL,
        auditEntries: async (action: AuditAction) => await repos.AuditLogEntrySQL.find({ where: { action } }),
        clearAudit: async () => await repos.AuditLogEntrySQL.clear(),
    });
});
