import { RouteDecorators } from "@rapidrest/service-core";
import { BookingRouteMongo } from "../../../src/routes/mongo/BookingRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/bookings")
export class BookingRoute extends BookingRouteMongo {}
