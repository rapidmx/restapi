///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import { BookingMongo, BookingTypeMongo, CalendarEventMongo, FolderMongo, MailboxMongo } from "../../mongo.js";
import { BaseBookingRoute } from "../BaseBookingRoute.js";
const { Model } = RouteDecorators;

/** `@Model(BookingMongo)` is what lets `BaseBookingRoute.persistBooking()`'s `@Transactional()` resolve which
 * datasource to open a transaction against - see the `modelClass` getter there. */
@Model(BookingMongo)
export class BookingRouteMongo extends BaseBookingRoute<
    BookingTypeMongo,
    BookingMongo,
    CalendarEventMongo,
    FolderMongo,
    MailboxMongo
> {
    protected bookingTypeClass: any = BookingTypeMongo;
    protected bookingClass: any = BookingMongo;
    protected calendarEventClass: any = CalendarEventMongo;
    protected folderClass: any = FolderMongo;
    protected mailboxClass: any = MailboxMongo;
}
