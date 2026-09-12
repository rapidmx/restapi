import { RouteDecorators } from "@rapidrest/service-core";
import { MatterSearchRouteSQL } from "../../../src/routes/sql/MatterSearchRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/matter-search")
export class MatterSearchRoute extends MatterSearchRouteSQL {}
