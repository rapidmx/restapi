import { RouteDecorators } from "@rapidrest/service-core";
import { CalendarEventRouteMongo } from "../../../src/routes/mongo/CalendarEventRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/calendar-events")
export class CalendarEventRoute extends CalendarEventRouteMongo {}
