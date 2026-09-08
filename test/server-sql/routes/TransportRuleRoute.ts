import { RouteDecorators } from "@rapidrest/service-core";
import { TransportRuleRouteSQL } from "../../../src/routes/sql/TransportRuleRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/transport-rules")
export class TransportRuleRoute extends TransportRuleRouteSQL {}
