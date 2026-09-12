import { RouteDecorators } from "@rapidrest/service-core";
import { RetentionPolicyRouteMongo } from "../../../src/routes/mongo/RetentionPolicyRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/retention-policy")
export class RetentionPolicyRoute extends RetentionPolicyRouteMongo {}
