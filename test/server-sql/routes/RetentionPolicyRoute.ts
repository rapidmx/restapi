import { RouteDecorators } from "@rapidrest/service-core";
import { RetentionPolicyRouteSQL } from "../../../src/routes/sql/RetentionPolicyRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/retention-policy")
export class RetentionPolicyRoute extends RetentionPolicyRouteSQL {}
