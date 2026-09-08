import { RouteDecorators } from "@rapidrest/service-core";
import { FocusedInboxOverrideRouteSQL } from "../../../src/routes/sql/FocusedInboxOverrideRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/focused-inbox-overrides")
export class FocusedInboxOverrideRoute extends FocusedInboxOverrideRouteSQL {}
