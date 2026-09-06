///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { QuarantineEntryMongo } from "../../mongo.js";
import { BaseScopedChildRoute } from "../BaseScopedChildRoute.js";
const { Model } = RouteDecorators;

/**
 * `QuarantineEntry` has no `AccessControlList` of its own — like every other `mailboxUid`-scoped entity (see
 * `ContactListRouteMongo`), `BaseScopedChildRoute` already provides exactly the CRUD/permission behavior
 * needed: a mailbox owner or delegate sees their own mailbox's quarantined mail (a legitimate webmail
 * "Spam/Quarantine" folder), a trusted caller sees everything via the same ACL bypass every other route in
 * this library already gets for free. "Releasing" a quarantined entry is just a normal `PUT /:id` updating
 * `releasedAt`/`releasedByUserUid` — no bespoke endpoint needed. Re-injecting the released message back into
 * normal delivery (if desired) is a separate follow-up, not implemented here.
 */
@Model(QuarantineEntryMongo)
export class QuarantineRouteMongo extends BaseScopedChildRoute<QuarantineEntryMongo> {
    protected readonly repoUtilsClass: any = RepoUtils;
    protected readonly scopeProperty: string = "mailboxUid";
}
