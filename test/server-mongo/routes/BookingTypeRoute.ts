import { RouteDecorators } from "@rapidrest/service-core";
import { BookingTypeRouteMongo } from "../../../src/routes/mongo/BookingTypeRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/booking-types")
export class BookingTypeRoute extends BookingTypeRouteMongo {}
