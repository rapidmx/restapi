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
import { CalendarShareLink } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Nullable } = ObjectDecorators;
const { Column, Entity, Index } = PersistenceDecorators;

/**
 * Implementation of the `CalendarShareLink` interface for storage in a MongoDB database. If SQL is desired,
 * please use `models.sql.CalendarShareLinkSQL` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("mongo")
@Entity()
@Description(
    "Supports anonymous, unauthenticated external access to a `CalendarEvent` folder's free/busy information " +
        "(or broader access, per `permittedActions`) via a shareable link.",
)
@Index("calsharelink_token", ["token"], { unique: true })
@Index("calsharelink_folder", ["folderUid"])
@Protect(
    {
        uid: "CalendarShareLink",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class CalendarShareLinkMongo extends BaseMongoEntity implements CalendarShareLink {
    @Column()
    @Description("The unique, unguessable token embedded in the shared URL and used as the ACL `userOrRoleId`.")
    public token: string = "";

    @Column()
    @Description("The unique identifier of the `Folder` (of type `CALENDAR`) being shared.")
    public folderUid: string = "";

    @Column()
    @Description("The actions (see `ACLAction`) granted to holders of this link, e.g. `[\"freebusy\"]` or `[\"read\"]`.")
    public permittedActions: string[] = [];

    @Column()
    @Description("The date/time after which this link is no longer valid.")
    @Nullable
    public expiresAt?: Date;

    @Column()
    @Description("The unique identifier of the `User` that created this share link.")
    public createdByUserUid: string = "";

    constructor(other?: Partial<CalendarShareLinkMongo>) {
        super(other);

        if (other) {
            this.token = other.token !== undefined ? other.token : this.token;
            this.folderUid = other.folderUid !== undefined ? other.folderUid : this.folderUid;
            this.permittedActions = other.permittedActions !== undefined ? other.permittedActions : this.permittedActions;
            this.expiresAt = "expiresAt" in other ? other.expiresAt : this.expiresAt;
            this.createdByUserUid = other.createdByUserUid !== undefined ? other.createdByUserUid : this.createdByUserUid;
        }
    }
}
