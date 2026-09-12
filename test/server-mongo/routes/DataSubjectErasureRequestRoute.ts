import { RouteDecorators } from "@rapidrest/service-core";
import { DataSubjectErasureRequestRouteMongo } from "../../../src/routes/mongo/DataSubjectErasureRequestRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/erasure-requests")
export class DataSubjectErasureRequestRoute extends DataSubjectErasureRequestRouteMongo {}
