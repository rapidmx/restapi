///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { LabelMongo, MessageMongo } from "../../mongo.js";
import { BaseLabelRoute } from "../BaseLabelRoute.js";
const { Model } = RouteDecorators;

@Model(LabelMongo)
export class LabelRouteMongo extends BaseLabelRoute<LabelMongo, MessageMongo> {
    protected readonly repoUtilsClass: any = RepoUtils;
    protected messageClass: any = MessageMongo;
}
