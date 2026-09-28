import { RouteDecorators } from "@rapidrest/service-core";
import { ServerInfoRouteSQL } from "../../../src/routes/sql/ServerInfoRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/.well-known/rapidmx/server-info")
export class ServerInfoRoute extends ServerInfoRouteSQL {}
