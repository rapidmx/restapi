///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BaseEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { AuditAction, AuditLogEntry } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * Implementation of the `AuditLogEntry` interface for storage in a SQL database. If MongoDB is desired,
 * please use `models.mongo.AuditLogEntryMongo` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@Description("A single durable, admin-queryable record of an admin/policy or sensitive mailbox-content action.")
@Index("audit_log_mailbox", ["mailboxUid"])
@Index("audit_log_actor", ["actorUserUid"])
@Index("audit_log_action", ["action"])
@Protect(
    {
        uid: "AuditLogEntry",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class AuditLogEntrySQL extends BaseEntity implements AuditLogEntry {
    @Column({ nullable: true })
    @Description("The mailbox this action pertains to, if any.")
    @Nullable
    public mailboxUid?: string;

    @Column({ nullable: true })
    @Description("The uid of the user who performed this action, if a human caller.")
    @Nullable
    public actorUserUid?: string;

    // `type: "varchar"` is required on every enum-typed column - see the identical note on
    // `IngestQueueEntrySQL.status`.
    @Column({ type: "varchar" })
    @Description("The kind of action performed.")
    public action: AuditAction = AuditAction.MAILBOX_CREATE;

    @Column()
    @Description("The entity type this action was performed on.")
    public targetType: string = "";

    @Column()
    @Description("The uid of the specific record this action was performed on.")
    public targetUid: string = "";

    @Column({ nullable: true })
    @Description("The caller's IP address, if available.")
    @Nullable
    public ip?: string;

    @Column({ type: "simple-json", nullable: true })
    @Description("A small, action-specific identifying snapshot - not a full field-level diff.")
    @Nullable
    public details?: Record<string, any>;

    constructor(other?: Partial<AuditLogEntrySQL>) {
        super(other);

        if (other) {
            this.mailboxUid = "mailboxUid" in other ? other.mailboxUid : this.mailboxUid;
            this.actorUserUid = "actorUserUid" in other ? other.actorUserUid : this.actorUserUid;
            this.action = other.action !== undefined ? other.action : this.action;
            this.targetType = other.targetType !== undefined ? other.targetType : this.targetType;
            this.targetUid = other.targetUid !== undefined ? other.targetUid : this.targetUid;
            this.ip = "ip" in other ? other.ip : this.ip;
            this.details = "details" in other ? other.details : this.details;
        }
    }
}
