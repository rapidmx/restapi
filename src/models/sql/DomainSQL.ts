///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BaseEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { Domain } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * Implementation of the `Domain` interface for storage in a SQL database. If MongoDB is desired, please
 * use `models.mongo.DomainMongo` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@Description("An admin-managed domain this mail server accepts mail on, once its DNS ownership is verified.")
@Protect(
    {
        uid: "Domain",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class DomainSQL extends BaseEntity implements Domain {
    @Column()
    @Description("The hostname this mail server accepts mail on.")
    public name: string = "";

    @Column()
    @Description("Whether this domain is currently enforced.")
    public enabled: boolean = true;

    @Column()
    @Description("Whether DNS ownership has been proven via verificationToken.")
    public verified: boolean = false;

    @Column()
    @Description("The token that must appear in a TXT record on name to prove ownership.")
    public verificationToken: string = "";

    @Column({ nullable: true })
    @Description("When verified became true, if it has.")
    @Nullable
    public verifiedAt?: Date;

    @Column({ nullable: true })
    @Description("Last time a verification check ran against this domain, whether or not it succeeded.")
    @Nullable
    public lastCheckedAt?: Date;

    @Column({ nullable: true })
    @Description("DKIM selector - the admin's own MTA/OpenDKIM key pair is under this selector name.")
    @Nullable
    public dkimSelector?: string;

    @Column({ nullable: true })
    @Description("The base64 public-key portion (the p= value) of that same DKIM key pair.")
    @Nullable
    public dkimPublicKey?: string;

    @Column({ type: "varchar", nullable: true })
    @Description("DMARC policy to recommend/check for - defaults to 'none' if not customized.")
    @Nullable
    public dmarcPolicy?: "none" | "quarantine" | "reject";

    @Column({ nullable: true })
    @Description("Optional mailto target for DMARC aggregate reports.")
    @Nullable
    public dmarcReportEmail?: string;

    constructor(other?: Partial<DomainSQL>) {
        super(other);

        if (other) {
            this.name = other.name !== undefined ? other.name : this.name;
            this.enabled = other.enabled !== undefined ? other.enabled : this.enabled;
            this.verified = other.verified !== undefined ? other.verified : this.verified;
            this.verificationToken = other.verificationToken !== undefined ? other.verificationToken : this.verificationToken;
            this.verifiedAt = "verifiedAt" in other ? other.verifiedAt : this.verifiedAt;
            this.lastCheckedAt = "lastCheckedAt" in other ? other.lastCheckedAt : this.lastCheckedAt;
            this.dkimSelector = "dkimSelector" in other ? other.dkimSelector : this.dkimSelector;
            this.dkimPublicKey = "dkimPublicKey" in other ? other.dkimPublicKey : this.dkimPublicKey;
            this.dmarcPolicy = "dmarcPolicy" in other ? other.dmarcPolicy : this.dmarcPolicy;
            this.dmarcReportEmail = "dmarcReportEmail" in other ? other.dmarcReportEmail : this.dmarcReportEmail;
        }
    }
}
