///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    ACLAction,
    DocDecorators,
    ModelDecorators,
    PersistenceDecorators,
    RecoverableBaseMongoEntity,
} from "@rapidrest/service-core";
import { ObjectDecorators } from "@rapidrest/core";
import { Folder, FolderType } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Nullable } = ObjectDecorators;
const { Column, Entity, Index } = PersistenceDecorators;

/**
 * Implementation of the `Folder` interface for storage in a MongoDB database. If SQL is desired, please use
 * `models.sql.FolderSQL` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("mongo")
@Entity()
@Description(
    "Defines a single folder within a `Mailbox`. Folders form a hierarchy via `parentFolderUid` and hold " +
        "`Message`, `CalendarEvent`, `Contact`, `Task`, or `Note` records depending on `type`.",
)
@Index("folder_mailbox", ["mailboxUid"])
@Index("folder_parent", ["parentFolderUid"])
@Protect(
    {
        uid: "Folder",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    true,
)
export class FolderMongo extends RecoverableBaseMongoEntity implements Folder {
    @Column()
    @Description("The unique identifier of the `Mailbox` this folder belongs to.")
    public mailboxUid: string = "";

    @Column()
    @Description("The display name of the folder.")
    public name: string = "";

    @Column()
    @Description("The kind of well-known folder this is, or `USER` for an ordinary user-created folder.")
    public type: FolderType = FolderType.USER;

    @Column()
    @Description("The unique identifier of the parent folder, or `undefined` if this is a top-level folder.")
    @Nullable
    public parentFolderUid?: string;

    @Column()
    @Description("The number of unread items contained directly in this folder.")
    public unreadCount: number = 0;

    @Column()
    @Description("The total number of items contained directly in this folder.")
    public totalCount: number = 0;

    @Column()
    @Description(
        "A monotonically increasing counter bumped on every change (add/change/delete of a contained item, or " +
            "of the folder itself) to this folder's contents. EAS `SyncKey` and MAPI ICS-style folder sync state " +
            "are both derived from this value.",
    )
    public syncKeyVersion: number = 0;

    constructor(other?: Partial<FolderMongo>) {
        super(other);

        if (other) {
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.name = other.name !== undefined ? other.name : this.name;
            this.type = other.type !== undefined ? other.type : this.type;
            this.parentFolderUid = "parentFolderUid" in other ? other.parentFolderUid : this.parentFolderUid;
            this.unreadCount = other.unreadCount !== undefined ? other.unreadCount : this.unreadCount;
            this.totalCount = other.totalCount !== undefined ? other.totalCount : this.totalCount;
            this.syncKeyVersion = other.syncKeyVersion !== undefined ? other.syncKeyVersion : this.syncKeyVersion;
        }
    }
}
