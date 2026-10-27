import { RouteDecorators } from "@rapidrest/service-core";
import { IntegrationsRouteSQL } from "../../../src/routes/sql/IntegrationsRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/integrations")
export class IntegrationsRoute extends IntegrationsRouteSQL {}
