import { RouteDecorators } from "@rapidrest/service-core";
import { IntegrationsRouteMongo } from "../../../src/routes/mongo/IntegrationsRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/integrations")
export class IntegrationsRoute extends IntegrationsRouteMongo {}
