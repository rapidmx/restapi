///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { OofReplySuppressionCleanupJob } from "../OofReplySuppressionCleanupJob.js";
import { OofReplySuppressionMongo } from "../../mongo.js";

export class OofReplySuppressionCleanupJobMongo extends OofReplySuppressionCleanupJob<OofReplySuppressionMongo> {
    protected oofReplySuppressionClass: any = OofReplySuppressionMongo;
}
