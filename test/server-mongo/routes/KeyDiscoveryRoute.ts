import { RouteDecorators } from "@rapidrest/service-core";
import { KeyDiscoveryRouteMongo } from "../../../src/routes/mongo/KeyDiscoveryRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/.well-known/rapidmx/keys")
export class KeyDiscoveryRoute extends KeyDiscoveryRouteMongo {}
