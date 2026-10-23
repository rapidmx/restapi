///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import { ZeroAccessIndexRouteSQL } from "../../../src/routes/sql/ZeroAccessIndexRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/mailboxes")
export class ZeroAccessIndexRoute extends ZeroAccessIndexRouteSQL {}
