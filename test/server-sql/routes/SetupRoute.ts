import { RouteDecorators } from "@rapidrest/service-core";
import { SetupRouteSQL } from "../../../src/routes/sql/SetupRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/setup")
export class SetupRoute extends SetupRouteSQL {}
