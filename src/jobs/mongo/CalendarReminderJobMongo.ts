///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { CalendarReminderJob } from "../CalendarReminderJob.js";
import { CalendarEventMongo } from "../../mongo.js";

export class CalendarReminderJobMongo extends CalendarReminderJob<CalendarEventMongo> {
    protected calendarEventClass: any = CalendarEventMongo;
}
