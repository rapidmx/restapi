///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AppearancePreferencesSQL } from "../../sql.js";
import { BaseAppearanceRoute } from "../BaseAppearanceRoute.js";

export class AppearanceRouteSQL extends BaseAppearanceRoute<AppearancePreferencesSQL> {
    protected appearanceClass: any = AppearancePreferencesSQL;
}
