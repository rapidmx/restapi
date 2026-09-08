import { RouteDecorators } from "@rapidrest/service-core";
import { BookingRouteSQL } from "../../../src/routes/sql/BookingRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/bookings")
export class BookingRoute extends BookingRouteSQL {}
