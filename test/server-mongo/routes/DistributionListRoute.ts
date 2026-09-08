import { RouteDecorators } from "@rapidrest/service-core";
import { DistributionListRouteMongo } from "../../../src/routes/mongo/DistributionListRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/distribution-lists")
export class DistributionListRoute extends DistributionListRouteMongo {}
