///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    ACLAction,
    DocDecorators,
    ModelDecorators,
    PersistenceDecorators,
    RecoverableBaseEntity,
} from "@rapidrest/service-core";
import { ObjectDecorators } from "@rapidrest/core";
import { Task, TaskPriority } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Nullable } = ObjectDecorators;
const { Column, Entity, Index } = PersistenceDecorators;

/**
 * Implementation of the `Task` interface for storage in a SQL database. If MongoDB is desired, please use
 * `models.mongo.TaskMongo` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@Description("Defines a single to-do item stored in a `Folder` of type `TASKS`.")
@Index("task_folder", ["folderUid"])
@Protect(
    {
        uid: "Task",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class TaskSQL extends RecoverableBaseEntity implements Task {
    @Column()
    @Description("The unique identifier of the `Mailbox` this task belongs to.")
    public mailboxUid: string = "";

    @Column()
    @Description("The unique identifier of the `Folder` (of type `TASKS`) this task resides in.")
    public folderUid: string = "";

    @Column()
    @Description("The title of the task.")
    public title: string = "";

    @Column({ nullable: true })
    @Description("The body/description of the task.")
    @Nullable
    public body?: string;

    @Column({ nullable: true })
    @Description("The date the task is due.")
    @Nullable
    public dueDate?: Date;

    @Column()
    @Description("`true` if the task has been completed.")
    public completed: boolean = false;

    // `type: "varchar"` is required on every enum-typed column: TypeScript's `emitDecoratorMetadata` reflects
    // a string enum's design type as the enum object itself, not a primitive constructor, which TypeORM/
    // better-sqlite3 cannot resolve into a column type on its own (it would otherwise fail at
    // `DataSource.initialize()` with "Data type 'undefined' ... is not supported").
    @Column({ type: "varchar" })
    @Description("The priority of the task.")
    public priority: TaskPriority = TaskPriority.NORMAL;

    @Column({ nullable: true })
    @Description("The date/time a reminder for this task should be dispatched.")
    @Nullable
    public reminderDate?: Date;

    constructor(other?: Partial<TaskSQL>) {
        super(other);

        if (other) {
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.folderUid = other.folderUid !== undefined ? other.folderUid : this.folderUid;
            this.title = other.title !== undefined ? other.title : this.title;
            this.body = "body" in other ? other.body : this.body;
            this.dueDate = "dueDate" in other ? other.dueDate : this.dueDate;
            this.completed = other.completed !== undefined ? other.completed : this.completed;
            this.priority = other.priority !== undefined ? other.priority : this.priority;
            this.reminderDate = "reminderDate" in other ? other.reminderDate : this.reminderDate;
        }
    }
}
