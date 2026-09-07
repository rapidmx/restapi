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
import { TaskList } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;

/**
 * Implementation of the `TaskList` interface for storage in a MongoDB database. If SQL is desired, please use
 * `models.sql.TaskListSQL` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("mongo")
@Entity()
@Description("Defines a named grouping of `Task` records within a `Mailbox` — the `Task` analog of `ContactList`.")
@Index("tasklist_mailbox", ["mailboxUid"])
@Protect(
    {
        uid: "TaskList",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class TaskListMongo extends BaseMongoEntity implements TaskList {
    @Column()
    @Description("The unique identifier of the `Mailbox` this task list belongs to.")
    public mailboxUid: string = "";

    @Column()
    @Description("The display name of the task list.")
    public name: string = "";

    constructor(other?: Partial<TaskListMongo>) {
        super(other);

        if (other) {
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.name = other.name !== undefined ? other.name : this.name;
        }
    }
}
