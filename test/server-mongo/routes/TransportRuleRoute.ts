import { RouteDecorators } from "@rapidrest/service-core";
import { TransportRuleRouteMongo } from "../../../src/routes/mongo/TransportRuleRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/transport-rules")
export class TransportRuleRoute extends TransportRuleRouteMongo {}
