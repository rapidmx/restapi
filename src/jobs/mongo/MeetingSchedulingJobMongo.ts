///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MeetingSchedulingJob } from "../MeetingSchedulingJob.js";
import { CalendarEventMongo } from "../../mongo.js";

export class MeetingSchedulingJobMongo extends MeetingSchedulingJob<CalendarEventMongo> {
    protected calendarEventClass: any = CalendarEventMongo;
}
