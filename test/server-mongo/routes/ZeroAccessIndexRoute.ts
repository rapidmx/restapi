///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import { ZeroAccessIndexRouteMongo } from "../../../src/routes/mongo/ZeroAccessIndexRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/mailboxes")
export class ZeroAccessIndexRoute extends ZeroAccessIndexRouteMongo {}
