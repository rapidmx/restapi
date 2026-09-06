///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ACLAction, BaseEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { ObjectDecorators } from "@rapidrest/core";
import { QuarantineEntry, QuarantineReason } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Nullable } = ObjectDecorators;
const { Column, Entity, Index } = PersistenceDecorators;

/**
 * Implementation of the `QuarantineEntry` interface for storage in a SQL database. If MongoDB is desired,
 * please use `models.mongo.QuarantineEntryMongo` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@Description(
    "Defines a single message held out of normal delivery pending review, because it was found infected or " +
        "because organizational policy quarantines spam above a configured threshold rather than delivering to Junk.",
)
@Index("quarantine_mailbox", ["mailboxUid"])
@Protect(
    {
        uid: "QuarantineEntry",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class QuarantineEntrySQL extends BaseEntity implements QuarantineEntry {
    @Column()
    @Description("The unique identifier of the `Mailbox` the message was addressed to.")
    public mailboxUid: string = "";

    @Column({ nullable: true })
    @Description("The unique identifier of the `Message` record, if one was ever created for this delivery attempt.")
    @Nullable
    public originalMessageUid?: string;

    // `type: "varchar"` is required on every enum-typed column: TypeScript's `emitDecoratorMetadata` reflects
    // a string enum's design type as the enum object itself, not a primitive constructor, which TypeORM/
    // better-sqlite3 cannot resolve into a column type on its own (it would otherwise fail at
    // `DataSource.initialize()` with "Data type 'undefined' ... is not supported").
    @Column({ type: "varchar" })
    @Description("The reason the message was quarantined.")
    public reason: QuarantineReason = QuarantineReason.OTHER;

    @Column()
    @Description("The unique identifier of the `ScanResult` produced for this message.")
    public scanResultUid: string = "";

    @Column()
    @Description("The key under which the original raw MIME source is stored in the `BlobStore`.")
    public rawBlobKey: string = "";

    @Column({ nullable: true })
    @Description("The date and time the message was released from quarantine, if released.")
    @Nullable
    public releasedAt?: Date;

    @Column({ nullable: true })
    @Description("The unique identifier of the `User` that released the message from quarantine, if released.")
    @Nullable
    public releasedByUserUid?: string;

    constructor(other?: Partial<QuarantineEntrySQL>) {
        super(other);

        if (other) {
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.originalMessageUid = "originalMessageUid" in other ? other.originalMessageUid : this.originalMessageUid;
            this.reason = other.reason !== undefined ? other.reason : this.reason;
            this.scanResultUid = other.scanResultUid !== undefined ? other.scanResultUid : this.scanResultUid;
            this.rawBlobKey = other.rawBlobKey !== undefined ? other.rawBlobKey : this.rawBlobKey;
            this.releasedAt = "releasedAt" in other ? other.releasedAt : this.releasedAt;
            this.releasedByUserUid = "releasedByUserUid" in other ? other.releasedByUserUid : this.releasedByUserUid;
        }
    }
}
