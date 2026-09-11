import { RouteDecorators } from "@rapidrest/service-core";
import { LabelRouteSQL } from "../../../src/routes/sql/LabelRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/labels")
export class LabelRoute extends LabelRouteSQL {}
