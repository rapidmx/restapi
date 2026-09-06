///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { QuarantineRetentionJob } from "../QuarantineRetentionJob.js";
import { QuarantineEntryMongo } from "../../mongo.js";

export class QuarantineRetentionJobMongo extends QuarantineRetentionJob<QuarantineEntryMongo> {
    protected quarantineEntryClass: any = QuarantineEntryMongo;
}
