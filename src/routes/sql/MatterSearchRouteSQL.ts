///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { EscrowScopeSQL, MatterSQL } from "../../sql.js";
import { BaseMatterSearchRoute } from "../BaseMatterSearchRoute.js";

export class MatterSearchRouteSQL extends BaseMatterSearchRoute<MatterSQL> {
    protected matterClass: any = MatterSQL;
    protected escrowScopeClass: any = EscrowScopeSQL;
}
