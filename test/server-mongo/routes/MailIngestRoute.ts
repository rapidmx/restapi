import { RouteDecorators } from "@rapidrest/service-core";
import { MailIngestRouteMongo } from "../../../src/routes/mongo/MailIngestRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/internal/mta")
export class MailIngestRoute extends MailIngestRouteMongo {}
