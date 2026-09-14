import { RouteDecorators } from "@rapidrest/service-core";
import { SetupRouteMongo } from "../../../src/routes/mongo/SetupRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/setup")
export class SetupRoute extends SetupRouteMongo {}
