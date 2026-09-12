import { RouteDecorators } from "@rapidrest/service-core";
import { DataExportRequestRouteSQL } from "../../../src/routes/sql/DataExportRequestRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/data-export-requests")
export class DataExportRequestRoute extends DataExportRequestRouteSQL {}
