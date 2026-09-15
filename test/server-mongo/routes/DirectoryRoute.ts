import { RouteDecorators } from "@rapidrest/service-core";
import { DirectoryRouteMongo } from "../../../src/routes/mongo/DirectoryRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/directory")
export class DirectoryRoute extends DirectoryRouteMongo {}
