import { RouteDecorators } from "@rapidrest/service-core";
import { QuarantineRouteSQL } from "../../../src/routes/sql/QuarantineRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/quarantine")
export class QuarantineRoute extends QuarantineRouteSQL {}
