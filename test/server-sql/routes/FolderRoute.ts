import { RouteDecorators } from "@rapidrest/service-core";
import { FolderRouteSQL } from "../../../src/routes/sql/FolderRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/folders")
export class FolderRoute extends FolderRouteSQL {}
