import { RouteDecorators } from "@rapidrest/service-core";
import { DnsProviderRouteSQL } from "../../../src/routes/sql/DnsProviderRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/dns-providers")
export class DnsProviderRoute extends DnsProviderRouteSQL {}
