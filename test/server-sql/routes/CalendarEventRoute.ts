import { RouteDecorators } from "@rapidrest/service-core";
import { CalendarEventRouteSQL } from "../../../src/routes/sql/CalendarEventRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/calendar-events")
export class CalendarEventRoute extends CalendarEventRouteSQL {}
