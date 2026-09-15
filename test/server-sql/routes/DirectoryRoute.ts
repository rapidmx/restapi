import { RouteDecorators } from "@rapidrest/service-core";
import { DirectoryRouteSQL } from "../../../src/routes/sql/DirectoryRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/directory")
export class DirectoryRoute extends DirectoryRouteSQL {}
