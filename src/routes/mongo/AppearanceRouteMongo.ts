///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AppearancePreferencesMongo } from "../../mongo.js";
import { BaseAppearanceRoute } from "../BaseAppearanceRoute.js";

export class AppearanceRouteMongo extends BaseAppearanceRoute<AppearancePreferencesMongo> {
    protected appearanceClass: any = AppearancePreferencesMongo;
}
