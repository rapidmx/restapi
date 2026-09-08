import { RouteDecorators } from "@rapidrest/service-core";
import { DomainRouteSQL } from "../../../src/routes/sql/DomainRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/domains")
export class DomainRoute extends DomainRouteSQL {}
