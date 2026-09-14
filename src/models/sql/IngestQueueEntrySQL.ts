///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ACLAction, BaseEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { ObjectDecorators } from "@rapidrest/core";
import { IngestQueueEntry, IngestStatus, QuarantineReason } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Nullable } = ObjectDecorators;
const { Column, Entity, Index } = PersistenceDecorators;

/**
 * Implementation of the `IngestQueueEntry` interface for storage in a SQL database. If MongoDB is desired,
 * please use `models.mongo.IngestQueueEntryMongo` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@Description(
    "A staging record for one raw message accepted by the MTA (Postfix) and handed to `MailIngestRoute`, " +
        "before scanning/parsing/delivery has run.",
)
@Index("ingestqueue_status", ["status"])
@Index("ingestqueue_mailbox", ["mailboxUid"])
@Index("ingestqueue_raw_blob_key", ["rawBlobKey"])
@Protect(
    {
        uid: "IngestQueueEntry",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class IngestQueueEntrySQL extends BaseEntity implements IngestQueueEntry {
    @Column()
    @Description("The resolved `Mailbox` this message is addressed to.")
    public mailboxUid: string = "";

    // `text`: the MTA passes MAIL FROM through unchecked, and a plain string column is `varchar(255)` on MySQL, which
    // rejects a longer value and loses the message. Not indexed.
    @Column({ type: "text" })
    @Description("The SMTP envelope sender (`MAIL FROM`) address.")
    public envelopeFrom: string = "";

    @Column({ type: "simple-json" })
    @Description("The SMTP envelope recipient (`RCPT TO`) addresses.")
    public envelopeTo: string[] = [];

    @Column()
    @Description("The key under which the raw MIME source is stored in the `BlobStore`.")
    public rawBlobKey: string = "";

    // `type: "varchar"` is required on every enum-typed column: TypeScript's `emitDecoratorMetadata` reflects
    // a string enum's design type as the enum object itself, not a primitive constructor, which TypeORM/
    // better-sqlite3 cannot resolve into a column type on its own (it would otherwise fail at
    // `DataSource.initialize()` with "Data type 'undefined' ... is not supported").
    @Column({ type: "varchar" })
    @Description("The current processing status of this queue entry.")
    public status: IngestStatus = IngestStatus.PENDING;

    @Column({ type: "text", nullable: true })
    @Description("The error message recorded if processing failed, if any.")
    @Nullable
    public errorMessage?: string;

    // See the identical `type: "varchar"` note on `status` above - required on every enum-typed column.
    @Column({ type: "varchar", nullable: true })
    @Description("Set when a `TransportRule`'s `quarantine` action matched this message.")
    @Nullable
    public quarantineReason?: QuarantineReason;

    @Column({ nullable: true })
    @Description("How many times `ScanQueueJob` has failed to process this entry - unset until the first failure.")
    @Nullable
    public attempts?: number;

    @Column({ nullable: true })
    @Description("When a failed entry becomes eligible to be retried - unset when it isn't waiting for a retry.")
    @Nullable
    public nextAttemptAt?: Date;

    @Column({ nullable: true })
    @Description("While scanning, when this claim expires and another worker may take the entry over.")
    @Nullable
    public scanLeaseExpiresAt?: Date;

    constructor(other?: Partial<IngestQueueEntrySQL>) {
        super(other);

        if (other) {
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.envelopeFrom = other.envelopeFrom !== undefined ? other.envelopeFrom : this.envelopeFrom;
            this.envelopeTo = other.envelopeTo !== undefined ? other.envelopeTo : this.envelopeTo;
            this.rawBlobKey = other.rawBlobKey !== undefined ? other.rawBlobKey : this.rawBlobKey;
            this.status = other.status !== undefined ? other.status : this.status;
            this.errorMessage = "errorMessage" in other ? other.errorMessage : this.errorMessage;
            this.quarantineReason = "quarantineReason" in other ? other.quarantineReason : this.quarantineReason;
            this.attempts = "attempts" in other ? other.attempts : this.attempts;
            this.nextAttemptAt = "nextAttemptAt" in other ? other.nextAttemptAt : this.nextAttemptAt;
            this.scanLeaseExpiresAt = "scanLeaseExpiresAt" in other ? other.scanLeaseExpiresAt : this.scanLeaseExpiresAt;
        }
    }
}
