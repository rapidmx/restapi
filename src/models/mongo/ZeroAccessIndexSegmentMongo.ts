///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { BaseMongoEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { ZeroAccessIndexSegment, ZeroAccessSegmentOrigin } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;

/**
 * Implementation of the `ZeroAccessIndexSegment` interface for storage in a MongoDB database. If SQL is desired, please use
 * `models.sql.ZeroAccessIndexSegmentSQL` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("mongo")
@Entity()
@Description("One week's compacted search index for a mailbox, encrypted to the mailbox's zero-access key.")
@Index("zero_access_index_segment_mailbox_week", ["mailboxUid", "weekId"])
@Protect(
    {
        uid: "ZeroAccessIndexSegment",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class ZeroAccessIndexSegmentMongo extends BaseMongoEntity implements ZeroAccessIndexSegment {
    @Column()
    @Description("The unique identifier of the `Mailbox` this segment belongs to.")
    public mailboxUid: string = "";

    @Column()
    @Description("ISO week (UTC), e.g. 2026-W43.")
    public weekId: string = "";

    @Column()
    @Description("1 for the week's first compaction, incremented each time later entries are folded in.")
    public generation: number = 1;

    @Column()
    @Description("Where the sealed segment file is stored.")
    public blobKey: string = "";

    @Column()
    @Description("The sealed file's size in bytes.")
    public bytes: number = 0;

    @Column()
    @Description("SHA-256 (hex) of the stored file.")
    public etag: string = "";

    @Column()
    @Description("Segment format version.")
    public schemaVersion: number = 1;

    @Column()
    @Description("Who built it: zero-access (compacted from server entries) or client (end-to-end encrypted mail).")
    public origin: ZeroAccessSegmentOrigin = "zero-access";

    @Column()
    @Description("Fingerprint of the zero-access key the file is encrypted to.")
    public keyFingerprint: string = "";

    @Column()
    @Description("How many entries this generation and the ones before it folded in.")
    public entryCount: number = 0;

    constructor(other?: Partial<ZeroAccessIndexSegmentMongo>) {
        super(other);

        if (other) {
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.weekId = other.weekId !== undefined ? other.weekId : this.weekId;
            this.generation = other.generation !== undefined ? other.generation : this.generation;
            this.blobKey = other.blobKey !== undefined ? other.blobKey : this.blobKey;
            this.bytes = other.bytes !== undefined ? other.bytes : this.bytes;
            this.etag = other.etag !== undefined ? other.etag : this.etag;
            this.schemaVersion = other.schemaVersion !== undefined ? other.schemaVersion : this.schemaVersion;
            this.origin = other.origin !== undefined ? other.origin : this.origin;
            this.keyFingerprint = other.keyFingerprint !== undefined ? other.keyFingerprint : this.keyFingerprint;
            this.entryCount = other.entryCount !== undefined ? other.entryCount : this.entryCount;
        }
    }
}
