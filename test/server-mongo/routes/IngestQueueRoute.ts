import { RouteDecorators } from "@rapidrest/service-core";
import { IngestQueueRouteMongo } from "../../../src/routes/mongo/IngestQueueRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/ingest-queue")
export class IngestQueueRoute extends IngestQueueRouteMongo {}
