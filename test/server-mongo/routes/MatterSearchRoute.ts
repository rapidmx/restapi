import { RouteDecorators } from "@rapidrest/service-core";
import { MatterSearchRouteMongo } from "../../../src/routes/mongo/MatterSearchRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/matter-search")
export class MatterSearchRoute extends MatterSearchRouteMongo {}
