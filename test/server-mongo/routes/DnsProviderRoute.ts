import { RouteDecorators } from "@rapidrest/service-core";
import { DnsProviderRouteMongo } from "../../../src/routes/mongo/DnsProviderRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/dns-providers")
export class DnsProviderRoute extends DnsProviderRouteMongo {}
