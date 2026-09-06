import { RouteDecorators } from "@rapidrest/service-core";
import { SearchRouteMongo } from "../../../src/routes/mongo/SearchRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/search")
export class SearchRoute extends SearchRouteMongo {}
