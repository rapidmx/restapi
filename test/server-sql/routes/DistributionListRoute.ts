import { RouteDecorators } from "@rapidrest/service-core";
import { DistributionListRouteSQL } from "../../../src/routes/sql/DistributionListRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/distribution-lists")
export class DistributionListRoute extends DistributionListRouteSQL {}
