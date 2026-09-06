///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { AttachmentMongo, MessageMongo } from "../../mongo.js";
import { BaseAttachmentRoute } from "../BaseAttachmentRoute.js";
const { Model } = RouteDecorators;

@Model(AttachmentMongo)
export class AttachmentRouteMongo extends BaseAttachmentRoute<AttachmentMongo, MessageMongo> {
    protected readonly repoUtilsClass: any = RepoUtils;
    protected messageClass: any = MessageMongo;
}
