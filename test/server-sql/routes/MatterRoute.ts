import { RouteDecorators } from "@rapidrest/service-core";
import { MatterRouteSQL } from "../../../src/routes/sql/MatterRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/matters")
export class MatterRoute extends MatterRouteSQL {}
