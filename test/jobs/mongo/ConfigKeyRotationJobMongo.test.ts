///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for ConfigKeyRotationJobMongo: a real in-memory MongoDB connection and a real `ObjectFactory` construct the job exactly
// as production wiring would, with a real `ConfigCipherMongo` reading a keyring file. The phases themselves are in ../configKeyRotationSuite.ts, shared with
// the SQL backend; see DomainVerificationJobMongo.test.ts for why `Server` is bypassed.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ACLUtils, ConnectionManager, MongoConnection, MongoRepository, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import config from "../../config.js";
import { ConfigKeyRotationJobMongo } from "../../../src/jobs/mongo/ConfigKeyRotationJobMongo.js";
import { AuditLogEntryMongo } from "../../../src/models/mongo/AuditLogEntryMongo.js";
import { ConfigKeyStateMongo } from "../../../src/models/mongo/ConfigKeyStateMongo.js";
import { DnsProviderMongo } from "../../../src/models/mongo/DnsProviderMongo.js";
import { IntegrationSettingsMongo } from "../../../src/models/mongo/IntegrationSettingsMongo.js";
import { PluginMongo } from "../../../src/models/mongo/PluginMongo.js";
import { AuditAction } from "../../../src/models/types.js";
import { LocalConfigKeyChannel } from "../../../src/secrets/ConfigKeyChannel.js";
import { ConfigCipherMongo } from "../../../src/util/mongo/ConfigCipherMongo.js";
import { configKeyRotationSuite } from "../configKeyRotationSuite.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

describe("ConfigKeyRotationJobMongo Tests (real DB + DI)", () => {
    const logger = Logger();
    const dir: string = fs.mkdtempSync(path.join(os.tmpdir(), "config-key-rotation-mongo-"));
    const keyringFile: string = path.join(dir, "keyring.json");
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    const repos: Record<string, MongoRepository<any>> = {};

    const clear = async (name: string): Promise<void> => {
        try {
            await repos[name].clear();
        } catch (err: any) {
            if (err.message !== "ns not found") {
                throw err;
            }
        }
    };

    beforeAll(async () => {
        await mongod.start();
        fs.writeFileSync(keyringFile, "");
        config.set("config_encryption:keyring_file", keyringFile);
        objectFactory = new ObjectFactory(config, logger);
        // Normally registered by `Server`'s own bootstrap - registered explicitly here since this file bypasses `Server`.
        objectFactory.register(ACLUtils);
        objectFactory.register(ConfigCipherMongo, "ConfigCipher");
        objectFactory.register(LocalConfigKeyChannel, "ConfigKeyChannel");

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        for (const cls of [ConfigKeyStateMongo, DnsProviderMongo, IntegrationSettingsMongo, PluginMongo, AuditLogEntryMongo]) {
            models.set(cls.name, cls);
        }
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("mongo");
        if (!(conn instanceof MongoConnection)) {
            throw new Error("Could not find mongo connection");
        }
        for (const name of models.keys()) {
            repos[name] = conn.getMongoRepository(name);
        }
        // What the job injects, built once so the suite can reach them.
        await objectFactory.newInstance("ConfigCipher", { name: "default" });
        await objectFactory.newInstance("ConfigKeyChannel", { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
        await mongod.stop();
        config.set("config_encryption:keyring_file", "");
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("Resolves the registered ConfigCipher and ConfigKeyChannel, and builds its repositories.", async () => {
        const job: any = await objectFactory.newInstance(ConfigKeyRotationJobMongo, { name: "default" });
        expect(job.cipher).toBeInstanceOf(ConfigCipherMongo);
        expect(job.channel).toBeInstanceOf(LocalConfigKeyChannel);
        expect(job.stateRepo).toBeDefined();
        expect(job.auditLogUtils).toBeDefined();
        // The record types that hold envelopes: a DNS provider's credentials and the Integrations settings' secrets.
        expect(job.sources.list().map((source: any) => [source.record, source.modelClass])).toEqual([
            ["DnsProvider", DnsProviderMongo],
            ["IntegrationSettings", IntegrationSettingsMongo],
        ]);
        await job.dispose();
    });

    configKeyRotationSuite({
        newJob: async () => await objectFactory.newInstance(ConfigKeyRotationJobMongo, { name: `replica-${uuid.v4()}` }),
        cipher: () => objectFactory.getInstance<any>("ConfigCipher")!,
        channel: () => objectFactory.getInstance<any>("ConfigKeyChannel")!,
        keyringFile: () => keyringFile,
        saveState: async (fields) => {
            await repos.ConfigKeyStateMongo.deleteMany({ uid: fields.uid } as any);
            await repos.ConfigKeyStateMongo.save(new ConfigKeyStateMongo(fields));
        },
        state: async () => (await repos.ConfigKeyStateMongo.findOne({ uid: "config-keys" } as any)) ?? undefined,
        clearState: async () => await clear("ConfigKeyStateMongo"),
        insertPlugin: async (uid, settings) => {
            await repos.PluginMongo.save(new PluginMongo({ uid, name: `@rapidmx/${uid}`, packageVersion: "1.0.0", enabled: true, settings: settings as any }));
        },
        plugin: async (uid) => (await repos.PluginMongo.findOne({ uid } as any))!,
        touchPlugin: async (uid, note) => {
            await repos.PluginMongo.updateOne({ uid } as any, { $set: { "settings.note": note }, $inc: { version: 1 } });
        },
        deletePlugin: async (uid) => {
            await repos.PluginMongo.deleteOne({ uid } as any);
        },
        clearPlugins: async () => await clear("PluginMongo"),
        pluginModel: () => PluginMongo,
        insertProvider: async (uid, credentials, credentialsGeneration) => {
            await repos.DnsProviderMongo.save(
                new DnsProviderMongo({ uid, name: `provider ${uid}`, type: "route53", zones: ["example.com"], options: { region: "us-east-1" }, credentials, credentialsGeneration } as any),
            );
        },
        provider: async (uid) => (await repos.DnsProviderMongo.findOne({ uid } as any))!,
        clearProviders: async () => await clear("DnsProviderMongo"),
        providerModel: () => DnsProviderMongo,
        insertIntegrations: async (sections) => {
            await repos.IntegrationSettingsMongo.save(new IntegrationSettingsMongo({ uid: "integrations", ...sections }));
        },
        integrations: async () => (await repos.IntegrationSettingsMongo.findOne({ uid: "integrations" } as any))!,
        clearIntegrations: async () => await clear("IntegrationSettingsMongo"),
        integrationsModel: () => IntegrationSettingsMongo,
        auditEntries: async (action: AuditAction) => await repos.AuditLogEntryMongo.find({ action }).toArray(),
        clearAudit: async () => await clear("AuditLogEntryMongo"),
    });
});
