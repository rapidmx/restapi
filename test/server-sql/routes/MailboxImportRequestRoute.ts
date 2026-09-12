import { RouteDecorators } from "@rapidrest/service-core";
import { MailboxImportRequestRouteSQL } from "../../../src/routes/sql/MailboxImportRequestRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/mailbox-import-requests")
export class MailboxImportRequestRoute extends MailboxImportRequestRouteSQL {}
