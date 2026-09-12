import { RouteDecorators } from "@rapidrest/service-core";
import { MatterExportRequestRouteMongo } from "../../../src/routes/mongo/MatterExportRequestRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/matter-export-requests")
export class MatterExportRequestRoute extends MatterExportRequestRouteMongo {}
