///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BaseMongoEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { ApexTxtSettings, DkimRotationState, DnsPublicationStatus, Domain, DomainOrigin } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * Implementation of the `Domain` interface for storage in a MongoDB database. If SQL is desired, please
 * use `models.sql.DomainSQL` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("mongo")
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
export class DomainMongo extends BaseMongoEntity implements Domain {
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

    @Column()
    @Description("When verified became true, if it has.")
    @Nullable
    public verifiedAt?: Date;

    @Column()
    @Description("Last time a verification check ran against this domain, whether or not it succeeded.")
    @Nullable
    public lastCheckedAt?: Date;

    @Column()
    @Description("DKIM selector - the MTA's DKIM key pair for this domain is filed under this selector name.")
    @Nullable
    public dkimSelector?: string;

    @Column()
    @Description("The base64 public-key portion (the p= value) of that same DKIM key pair.")
    @Nullable
    public dkimPublicKey?: string;

    @Column()
    @Description("DMARC policy to recommend/check for - defaults to 'none' if not customized.")
    @Nullable
    public dmarcPolicy?: "none" | "quarantine" | "reject";

    @Column()
    @Description("Optional mailto target for DMARC aggregate reports.")
    @Nullable
    public dmarcReportEmail?: string;

    @Column()
    @Description("When set, this domain is a pure alias of another domain (named here) and has no mailboxes of its own.")
    @Nullable
    public aliasOf?: string;

    @Column()
    @Description("The DNS provider config publishing this domain's records; unset means manual.")
    @Nullable
    public dnsProviderUid?: string | null;

    @Column()
    @Description("What the DNS controller and the live check last said about this domain's published records.")
    @Nullable
    public dnsPublication?: DnsPublicationStatus | null;

    @Column()
    @Description("Whether RapidMX manages this domain's apex TXT set to publish SPF, and the values it keeps there; unset means not managed.")
    @Nullable
    public apexTxt?: ApexTxtSettings | null;

    @Column()
    @Description("The DKIM key rotation in progress, if any.")
    @Nullable
    public dkimRotation?: DkimRotationState | null;

    @Column()
    @Description("Whether the active DKIM key came from the key provider (it can rotate) rather than being imported by hand.")
    @Nullable
    public dkimManaged?: boolean | null;

    @Column()
    @Description("Where the domain came from: 'seed' from the deployment's configuration, 'console' through the API; unset on older rows.")
    @Nullable
    public origin?: DomainOrigin | null;

    constructor(other?: Partial<DomainMongo>) {
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
            this.aliasOf = "aliasOf" in other ? other.aliasOf : this.aliasOf;
            this.dnsProviderUid = "dnsProviderUid" in other ? other.dnsProviderUid : this.dnsProviderUid;
            this.dnsPublication = "dnsPublication" in other ? other.dnsPublication : this.dnsPublication;
            this.apexTxt = "apexTxt" in other ? other.apexTxt : this.apexTxt;
            this.dkimRotation = "dkimRotation" in other ? other.dkimRotation : this.dkimRotation;
            this.dkimManaged = "dkimManaged" in other ? other.dkimManaged : this.dkimManaged;
            this.origin = "origin" in other ? other.origin : this.origin;
        }
    }
}
