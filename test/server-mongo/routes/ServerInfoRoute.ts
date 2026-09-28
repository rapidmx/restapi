import { RouteDecorators } from "@rapidrest/service-core";
import { ServerInfoRouteMongo } from "../../../src/routes/mongo/ServerInfoRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/.well-known/rapidmx/server-info")
export class ServerInfoRoute extends ServerInfoRouteMongo {}
