///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MeetingSchedulingJob } from "../MeetingSchedulingJob.js";
import { CalendarEventSQL } from "../../sql.js";

export class MeetingSchedulingJobSQL extends MeetingSchedulingJob<CalendarEventSQL> {
    protected calendarEventClass: any = CalendarEventSQL;
}
