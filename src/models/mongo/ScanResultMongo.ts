///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    ACLAction,
    BaseMongoEntity,
    DocDecorators,
    ModelDecorators,
    PersistenceDecorators,
} from "@rapidrest/service-core";
import { ObjectDecorators } from "@rapidrest/core";
import { AvVerdict, ScanResult, ScanTargetType, SpamVerdict } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Nullable } = ObjectDecorators;
const { Column, Entity, Index } = PersistenceDecorators;

/**
 * Implementation of the `ScanResult` interface for storage in a MongoDB database. If SQL is desired, please use
 * `models.sql.ScanResultSQL` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("mongo")
@Entity()
@Description("Defines the recorded outcome of running the SPAM/AV `ScanPipeline` against a `Message` or `Attachment`.")
@Index("scanresult_target", ["targetType", "targetUid"])
@Protect(
    {
        uid: "ScanResult",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class ScanResultMongo extends BaseMongoEntity implements ScanResult {
    @Column()
    @Description("The kind of record (`Message` or `Attachment`) that was scanned.")
    public targetType: ScanTargetType = ScanTargetType.MESSAGE;

    @Column()
    @Description("The unique identifier of the `Message` or `Attachment` (per `targetType`) that was scanned.")
    public targetUid: string = "";

    @Column()
    @Description("The numeric spam score assigned by the spam scan provider.")
    public spamScore: number = 0;

    @Column()
    @Description("The overall spam verdict.")
    public spamVerdict: SpamVerdict = SpamVerdict.CLEAN;

    @Column()
    @Description("The symbolic names (e.g. rspamd symbols) that contributed to the spam verdict.")
    public spamSymbols: string[] = [];

    @Column()
    @Description("The overall antivirus verdict.")
    public avVerdict: AvVerdict = AvVerdict.CLEAN;

    @Column()
    @Description("The name of the malware signature matched, if `avVerdict` is `INFECTED`.")
    @Nullable
    public avSignatureName?: string;

    @Column()
    @Description("The date and time the scan was performed.")
    public scannedAt: Date = new Date();

    @Column()
    @Description(
        "The version identifiers of the spam/AV engines used, for auditability as signatures update over time.",
    )
    public providerVersions: { spam?: string; av?: string } = {};

    constructor(other?: Partial<ScanResultMongo>) {
        super(other);

        if (other) {
            this.targetType = other.targetType !== undefined ? other.targetType : this.targetType;
            this.targetUid = other.targetUid !== undefined ? other.targetUid : this.targetUid;
            this.spamScore = other.spamScore !== undefined ? other.spamScore : this.spamScore;
            this.spamVerdict = other.spamVerdict !== undefined ? other.spamVerdict : this.spamVerdict;
            this.spamSymbols = other.spamSymbols !== undefined ? other.spamSymbols : this.spamSymbols;
            this.avVerdict = other.avVerdict !== undefined ? other.avVerdict : this.avVerdict;
            this.avSignatureName = "avSignatureName" in other ? other.avSignatureName : this.avSignatureName;
            this.scannedAt = other.scannedAt !== undefined ? other.scannedAt : this.scannedAt;
            this.providerVersions = other.providerVersions !== undefined ? other.providerVersions : this.providerVersions;
        }
    }
}
