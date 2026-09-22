import { RouteDecorators } from "@rapidrest/service-core";
import { AppearanceRouteMongo } from "../../../src/routes/mongo/AppearanceRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/appearance")
export class AppearanceRoute extends AppearanceRouteMongo {}
