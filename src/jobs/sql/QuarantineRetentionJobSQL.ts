///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { QuarantineRetentionJob } from "../QuarantineRetentionJob.js";
import { QuarantineEntrySQL } from "../../sql.js";

export class QuarantineRetentionJobSQL extends QuarantineRetentionJob<QuarantineEntrySQL> {
    protected quarantineEntryClass: any = QuarantineEntrySQL;
}
