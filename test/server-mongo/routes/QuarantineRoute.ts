import { RouteDecorators } from "@rapidrest/service-core";
import { QuarantineRouteMongo } from "../../../src/routes/mongo/QuarantineRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/quarantine")
export class QuarantineRoute extends QuarantineRouteMongo {}
