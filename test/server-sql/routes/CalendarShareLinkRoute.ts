import { RouteDecorators } from "@rapidrest/service-core";
import { CalendarShareLinkRouteSQL } from "../../../src/routes/sql/CalendarShareLinkRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/calendar-share-links")
export class CalendarShareLinkRoute extends CalendarShareLinkRouteSQL {}
