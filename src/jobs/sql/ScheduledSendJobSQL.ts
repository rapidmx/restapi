///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { ScheduledSendJob } from "../ScheduledSendJob.js";
import { CorrespondentSQL, DomainSQL, FolderSQL, MailboxSQL, MessageSQL } from "../../sql.js";

const { Config } = ObjectDecorators;

/** SQL drivers with one connection: two transactions cannot overlap on it ("cannot start a transaction within a transaction"). */
const SINGLE_CONNECTION_DRIVERS: readonly string[] = ["sqlite", "better-sqlite3", "sqljs"];

export class ScheduledSendJobSQL extends ScheduledSendJob<MessageSQL> {
    @Config("datastores:sql:type", "")
    private sqlDriver: string = "";

    protected messageClass: any = MessageSQL;
    protected folderClass: any = FolderSQL;
    protected mailboxClass: any = MailboxSQL;
    protected correspondentClass: any = CorrespondentSQL;
    protected domainClass: any = DomainSQL;

    /** One relay at a time on a single-connection driver (SQLite): concurrent relays would fail each other's transactions. */
    protected maxParallel(): number {
        return SINGLE_CONNECTION_DRIVERS.includes(this.sqlDriver) ? 1 : super.maxParallel();
    }
}
