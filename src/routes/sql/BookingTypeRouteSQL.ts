///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { BookingTypeSQL } from "../../sql.js";
import { BaseBookingTypeRoute } from "../BaseBookingTypeRoute.js";
const { Model } = RouteDecorators;

@Model(BookingTypeSQL)
export class BookingTypeRouteSQL extends BaseBookingTypeRoute<BookingTypeSQL> {
    protected readonly repoUtilsClass: any = RepoUtils;
}
