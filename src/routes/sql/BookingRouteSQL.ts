///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import { BookingSQL, BookingTypeSQL, CalendarEventSQL, FolderSQL, MailboxSQL } from "../../sql.js";
import { BaseBookingRoute } from "../BaseBookingRoute.js";
const { Model } = RouteDecorators;

/** `@Model(BookingSQL)` is what lets `BaseBookingRoute.persistBooking()`'s `@Transactional()` resolve which
 * datasource to open a transaction against - see the `modelClass` getter there. */
@Model(BookingSQL)
export class BookingRouteSQL extends BaseBookingRoute<BookingTypeSQL, BookingSQL, CalendarEventSQL, FolderSQL, MailboxSQL> {
    protected bookingTypeClass: any = BookingTypeSQL;
    protected bookingClass: any = BookingSQL;
    protected calendarEventClass: any = CalendarEventSQL;
    protected folderClass: any = FolderSQL;
    protected mailboxClass: any = MailboxSQL;
}
