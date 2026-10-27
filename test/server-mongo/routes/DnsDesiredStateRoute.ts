import { RouteDecorators } from "@rapidrest/service-core";
import { DnsDesiredStateRouteMongo } from "../../../src/routes/mongo/DnsDesiredStateRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/internal/dns")
export class DnsDesiredStateRoute extends DnsDesiredStateRouteMongo {}
