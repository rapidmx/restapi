///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BaseEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { ConfigEnvelope, DnsProvider, DnsProviderOptionValue, DnsProviderStatus, DnsProviderType } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * Implementation of the `DnsProvider` interface for storage in a SQL database. If MongoDB is desired, please use
 * `models.mongo.DnsProviderMongo` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@Description("A DNS hosting account this deployment publishes domain records through, with its credentials encrypted on the row.")
@Index("dnsprovider_name_key", ["nameKey"], { unique: true })
@Protect(
    {
        uid: "DnsProvider",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class DnsProviderSQL extends BaseEntity implements DnsProvider {
    @Column()
    @Description("Display name, unique (case-insensitive).")
    public name: string = "";

    @Column()
    @Description("The name in lowercase, unique: what keeps names unique when two writes race.")
    public nameKey: string = "";

    @Column({ type: "varchar" })
    @Description("The DNS hosting service: cloudflare, route53, rfc2136, google or azure.")
    public type: DnsProviderType = "cloudflare";

    @Column({ type: "simple-json" })
    @Description("The zones (apex names) this config may publish into.")
    public zones: string[] = [];

    @Column({ type: "simple-json" })
    @Description("Non-secret, type-specific options.")
    public options: Record<string, DnsProviderOptionValue> = {};

    @Column({ type: "simple-json", nullable: true })
    @Description("The credentials, one encrypted envelope per secret field, never the value.")
    @Nullable
    public credentials?: Record<string, ConfigEnvelope> | null;

    @Column({ default: 0 })
    @Description("Bumped on every change to the credentials, so the DNS controller rewrites the external-dns Secret and rolls its pod.")
    public credentialsGeneration: number = 0;

    @Column({ type: "varchar", nullable: true })
    @Description("Where this config came from: installer or console.")
    @Nullable
    public origin?: "installer" | "console";

    @Column()
    @Description("Whether this config's external-dns instance runs.")
    public enabled: boolean = true;

    @Column()
    @Description("Whether records this deployment does not own yet may be taken over in these zones.")
    public allowTakeover: boolean = false;

    @Column({ type: "simple-json", nullable: true })
    @Description("What the DNS controller last reported about this config's external-dns instance.")
    @Nullable
    public status?: DnsProviderStatus | null;

    constructor(other?: Partial<DnsProviderSQL>) {
        super(other);

        if (other) {
            this.name = other.name !== undefined ? other.name : this.name;
            this.nameKey = other.nameKey !== undefined ? other.nameKey : other.name !== undefined ? other.name.toLowerCase() : this.nameKey;
            this.type = other.type !== undefined ? other.type : this.type;
            this.zones = other.zones !== undefined ? other.zones : this.zones;
            this.options = other.options !== undefined ? other.options : this.options;
            this.credentials = "credentials" in other ? other.credentials : this.credentials;
            this.credentialsGeneration = other.credentialsGeneration !== undefined ? other.credentialsGeneration : this.credentialsGeneration;
            this.origin = "origin" in other ? other.origin : this.origin;
            this.enabled = other.enabled !== undefined ? other.enabled : this.enabled;
            this.allowTakeover = other.allowTakeover !== undefined ? other.allowTakeover : this.allowTakeover;
            this.status = "status" in other ? other.status : this.status;
        }
    }
}
