import { RouteDecorators } from "@rapidrest/service-core";
import { MailIngestRouteSQL } from "../../../src/routes/sql/MailIngestRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/internal/mta")
export class MailIngestRoute extends MailIngestRouteSQL {}
