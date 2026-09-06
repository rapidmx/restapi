///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ExternalShareExpirationJob } from "../ExternalShareExpirationJob.js";
import { CalendarShareLinkMongo } from "../../mongo.js";

export class ExternalShareExpirationJobMongo extends ExternalShareExpirationJob<CalendarShareLinkMongo> {
    protected calendarShareLinkClass: any = CalendarShareLinkMongo;
}
