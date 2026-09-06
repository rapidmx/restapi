///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { CalendarReminderJob } from "../CalendarReminderJob.js";
import { CalendarEventSQL } from "../../sql.js";

export class CalendarReminderJobSQL extends CalendarReminderJob<CalendarEventSQL> {
    protected calendarEventClass: any = CalendarEventSQL;
}
