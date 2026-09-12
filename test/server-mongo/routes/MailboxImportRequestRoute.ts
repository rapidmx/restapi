import { RouteDecorators } from "@rapidrest/service-core";
import { MailboxImportRequestRouteMongo } from "../../../src/routes/mongo/MailboxImportRequestRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/mailbox-import-requests")
export class MailboxImportRequestRoute extends MailboxImportRequestRouteMongo {}
