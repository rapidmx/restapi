import { RouteDecorators } from "@rapidrest/service-core";
import { WkdRouteSQL } from "../../../src/routes/sql/WkdRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/.well-known/openpgpkey")
export class WkdRoute extends WkdRouteSQL {}
