///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { LabelMongo, MessageMongo } from "../../mongo.js";
import { buildMessageLabelFilterMongo } from "../../util/MessageListUtils.js";
import { BaseLabelRoute } from "../BaseLabelRoute.js";
const { Model } = RouteDecorators;

@Model(LabelMongo)
export class LabelRouteMongo extends BaseLabelRoute<LabelMongo, MessageMongo> {
    protected readonly repoUtilsClass: any = RepoUtils;
    protected messageClass: any = MessageMongo;

    protected buildLabelUidsFilter(labelUids: string[]): Record<string, any> {
        return buildMessageLabelFilterMongo(labelUids);
    }
}
