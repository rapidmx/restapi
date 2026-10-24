import { RouteDecorators } from "@rapidrest/service-core";
import { WkdRouteMongo } from "../../../src/routes/mongo/WkdRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/.well-known/openpgpkey")
export class WkdRoute extends WkdRouteMongo {}
