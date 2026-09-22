import { RouteDecorators } from "@rapidrest/service-core";
import { AppearanceRouteSQL } from "../../../src/routes/sql/AppearanceRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/appearance")
export class AppearanceRoute extends AppearanceRouteSQL {}
