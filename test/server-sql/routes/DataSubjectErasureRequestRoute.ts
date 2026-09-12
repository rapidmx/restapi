import { RouteDecorators } from "@rapidrest/service-core";
import { DataSubjectErasureRequestRouteSQL } from "../../../src/routes/sql/DataSubjectErasureRequestRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/erasure-requests")
export class DataSubjectErasureRequestRoute extends DataSubjectErasureRequestRouteSQL {}
