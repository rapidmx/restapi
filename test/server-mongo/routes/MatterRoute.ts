import { RouteDecorators } from "@rapidrest/service-core";
import { MatterRouteMongo } from "../../../src/routes/mongo/MatterRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/matters")
export class MatterRoute extends MatterRouteMongo {}
