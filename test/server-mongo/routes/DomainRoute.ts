import { RouteDecorators } from "@rapidrest/service-core";
import { DomainRouteMongo } from "../../../src/routes/mongo/DomainRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/domains")
export class DomainRoute extends DomainRouteMongo {}
