///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ExternalShareExpirationJob } from "../ExternalShareExpirationJob.js";
import { CalendarShareLinkSQL } from "../../sql.js";

export class ExternalShareExpirationJobSQL extends ExternalShareExpirationJob<CalendarShareLinkSQL> {
    protected calendarShareLinkClass: any = CalendarShareLinkSQL;
}
