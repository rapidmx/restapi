import { RouteDecorators } from "@rapidrest/service-core";
import { CalendarShareLinkRouteMongo } from "../../../src/routes/mongo/CalendarShareLinkRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/calendar-share-links")
export class CalendarShareLinkRoute extends CalendarShareLinkRouteMongo {}
