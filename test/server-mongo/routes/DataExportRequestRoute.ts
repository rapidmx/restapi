import { RouteDecorators } from "@rapidrest/service-core";
import { DataExportRequestRouteMongo } from "../../../src/routes/mongo/DataExportRequestRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/data-export-requests")
export class DataExportRequestRoute extends DataExportRequestRouteMongo {}
