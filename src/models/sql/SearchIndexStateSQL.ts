///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ACLAction, BaseEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { SearchIndexState } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;

/**
 * Implementation of the `SearchIndexState` interface for storage in a SQL database. If MongoDB is desired,
 * please use `models.mongo.SearchIndexStateMongo` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@Description(
    "Tracks whether a given entity's content is currently reflected in a specific `SearchProvider`'s index, " +
        "decoupling \"committed to the primary datastore\" from \"visible in search\" (the two are only " +
        "eventually consistent, reconciled by `SearchIndexJob`).",
)
@Index("searchindexstate_entity", ["entityType", "entityUid", "provider"], { unique: true })
@Protect(
    {
        uid: "SearchIndexState",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class SearchIndexStateSQL extends BaseEntity implements SearchIndexState {
    @Column()
    @Description("The type name of the entity this state row applies to.")
    public entityType: string = "";

    @Column()
    @Description("The unique identifier of the entity this state row applies to.")
    public entityUid: string = "";

    @Column()
    @Description("The name of the `SearchProvider` implementation this state row applies to.")
    public provider: string = "";

    @Column()
    @Description("The date and time the entity was last indexed.")
    public indexedAt: Date = new Date();

    @Column()
    @Description("A content hash used to detect whether re-indexing is needed after this state was last recorded.")
    public contentHash: string = "";

    constructor(other?: Partial<SearchIndexStateSQL>) {
        super(other);

        if (other) {
            this.entityType = other.entityType !== undefined ? other.entityType : this.entityType;
            this.entityUid = other.entityUid !== undefined ? other.entityUid : this.entityUid;
            this.provider = other.provider !== undefined ? other.provider : this.provider;
            this.indexedAt = other.indexedAt !== undefined ? other.indexedAt : this.indexedAt;
            this.contentHash = other.contentHash !== undefined ? other.contentHash : this.contentHash;
        }
    }
}
