import { RouteDecorators } from "@rapidrest/service-core";
import { KeyDiscoveryRouteSQL } from "../../../src/routes/sql/KeyDiscoveryRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/.well-known/rapidmx/keys")
export class KeyDiscoveryRoute extends KeyDiscoveryRouteSQL {}
