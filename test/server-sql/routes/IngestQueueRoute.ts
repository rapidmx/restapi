import { RouteDecorators } from "@rapidrest/service-core";
import { IngestQueueRouteSQL } from "../../../src/routes/sql/IngestQueueRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/ingest-queue")
export class IngestQueueRoute extends IngestQueueRouteSQL {}
