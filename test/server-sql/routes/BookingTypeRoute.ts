import { RouteDecorators } from "@rapidrest/service-core";
import { BookingTypeRouteSQL } from "../../../src/routes/sql/BookingTypeRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/booking-types")
export class BookingTypeRoute extends BookingTypeRouteSQL {}
