import { RouteDecorators } from "@rapidrest/service-core";
import { LabelRouteMongo } from "../../../src/routes/mongo/LabelRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/labels")
export class LabelRoute extends LabelRouteMongo {}
