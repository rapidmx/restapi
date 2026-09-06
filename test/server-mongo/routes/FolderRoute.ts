import { RouteDecorators } from "@rapidrest/service-core";
import { FolderRouteMongo } from "../../../src/routes/mongo/FolderRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/folders")
export class FolderRoute extends FolderRouteMongo {}
