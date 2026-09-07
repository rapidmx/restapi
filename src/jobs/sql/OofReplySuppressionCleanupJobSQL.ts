///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { OofReplySuppressionCleanupJob } from "../OofReplySuppressionCleanupJob.js";
import { OofReplySuppressionSQL } from "../../sql.js";

export class OofReplySuppressionCleanupJobSQL extends OofReplySuppressionCleanupJob<OofReplySuppressionSQL> {
    protected oofReplySuppressionClass: any = OofReplySuppressionSQL;
}
