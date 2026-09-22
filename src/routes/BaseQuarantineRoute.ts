///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { type JWTUser } from "@rapidrest/core";
import { QuarantineEntry } from "../models/types.js";
import { BaseScopedChildRoute } from "./BaseScopedChildRoute.js";

/**
 * `mailboxUid`-scoped CRUD for `QuarantineEntry`. A mailbox owner or delegate can read their mailbox's quarantined
 * mail (an administrator has no access to it beyond `?scope=admin`, see `BaseScopedChildRoute`); only a trusted caller can write (`trustedOnlyWrites`) - entries are produced by the scan pipeline, and their
 * `reason`/`scanResultUid`/`rawBlobKey` are that pipeline's record of what happened.
 *
 * "Releasing" an entry is a trusted `PUT /:id` whose body sets `releasedAt` (any non-empty value): the server stamps
 * `releasedAt` (now) and `releasedByUserUid` (the caller) itself, ignoring the client's values for both, and an
 * already-released entry keeps its original stamp. Re-injecting the released message into delivery is a separate
 * follow-up, not implemented here.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseQuarantineRoute<T extends QuarantineEntry> extends BaseScopedChildRoute<T> {
    protected readonly scopeProperty: string = "mailboxUid";

    protected readonly trustedOnlyWrites: boolean = true;

    /** A trusted AND elevated caller reviews (and releases) any mailbox's entries with `?scope=admin`, audited. */
    protected readonly adminScope: boolean = true;

    protected async prepareCreate(obj: any, user: JWTUser | undefined): Promise<void> {
        await super.prepareCreate(obj, user);
        delete obj.releasedAt;
        delete obj.releasedByUserUid;
    }

    protected async prepareUpdate(obj: any, existing: T, user: JWTUser | undefined): Promise<void> {
        await super.prepareUpdate(obj, existing, user);
        const releaseRequested: boolean = !!obj.releasedAt;
        delete obj.releasedAt;
        delete obj.releasedByUserUid;
        if (releaseRequested && !existing.releasedAt) {
            obj.releasedAt = new Date();
            obj.releasedByUserUid = user?.uid;
        }
    }
}
