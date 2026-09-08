///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { BookingTypeMongo } from "../../mongo.js";
import { BaseBookingTypeRoute } from "../BaseBookingTypeRoute.js";
const { Model } = RouteDecorators;

@Model(BookingTypeMongo)
export class BookingTypeRouteMongo extends BaseBookingTypeRoute<BookingTypeMongo> {
    protected readonly repoUtilsClass: any = RepoUtils;
}
