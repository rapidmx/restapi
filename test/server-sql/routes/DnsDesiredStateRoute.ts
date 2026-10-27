import { RouteDecorators } from "@rapidrest/service-core";
import { DnsDesiredStateRouteSQL } from "../../../src/routes/sql/DnsDesiredStateRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/internal/dns")
export class DnsDesiredStateRoute extends DnsDesiredStateRouteSQL {}
