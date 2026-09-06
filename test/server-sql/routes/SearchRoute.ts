import { RouteDecorators } from "@rapidrest/service-core";
import { SearchRouteSQL } from "../../../src/routes/sql/SearchRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/search")
export class SearchRoute extends SearchRouteSQL {}
