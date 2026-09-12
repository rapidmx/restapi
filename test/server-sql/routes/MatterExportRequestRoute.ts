import { RouteDecorators } from "@rapidrest/service-core";
import { MatterExportRequestRouteSQL } from "../../../src/routes/sql/MatterExportRequestRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/matter-export-requests")
export class MatterExportRequestRoute extends MatterExportRequestRouteSQL {}
