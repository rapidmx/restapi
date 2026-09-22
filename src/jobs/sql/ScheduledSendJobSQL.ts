///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { ScheduledSendJob } from "../ScheduledSendJob.js";
import { DomainSQL, FolderSQL, MailboxSQL, MessageSQL } from "../../sql.js";

const { Config } = ObjectDecorators;

/** SQL drivers with one connection: two transactions cannot overlap on it ("cannot start a transaction within a transaction"). */
const SINGLE_CONNECTION_DRIVERS: readonly string[] = ["sqlite", "better-sqlite3", "sqljs"];

export class ScheduledSendJobSQL extends ScheduledSendJob<MessageSQL> {
    @Config()
    private appConfig: any;

    protected messageClass: any = MessageSQL;
    protected folderClass: any = FolderSQL;
    protected mailboxClass: any = MailboxSQL;
    protected domainClass: any = DomainSQL;

    /** One relay at a time on a single-connection driver (SQLite): concurrent relays would fail each other's transactions. */
    protected maxParallel(): number {
        const driver: string = String(this.appConfig?.get("datastores:sql:type") ?? "");
        return SINGLE_CONNECTION_DRIVERS.includes(driver) ? 1 : super.maxParallel();
    }
}
