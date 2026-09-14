///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Stand-ins for a plugin's per-mailbox model (such as the ActiveSync plugin's device state), used to check that
// `ErasureExecutionJob` purges `@MailboxScopedData()` models it has no compile-time knowledge of.
import { BaseEntity, BaseMongoEntity, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { MailboxScopedData } from "../../../src/plugins/PluginRegistry.js";
const { DataStore } = ModelDecorators;
const { Column, Entity } = PersistenceDecorators;

@DataStore("mongo")
@Entity()
@MailboxScopedData()
export class PluginMailboxDataMongo extends BaseMongoEntity {
    @Column()
    public mailboxUid: string = "";

    constructor(other?: Partial<PluginMailboxDataMongo>) {
        super(other);
        this.mailboxUid = other?.mailboxUid ?? this.mailboxUid;
    }
}

@DataStore("sql")
@Entity()
@MailboxScopedData()
export class PluginMailboxDataSQL extends BaseEntity {
    @Column()
    public mailboxUid: string = "";

    constructor(other?: Partial<PluginMailboxDataSQL>) {
        super(other);
        this.mailboxUid = other?.mailboxUid ?? this.mailboxUid;
    }
}
