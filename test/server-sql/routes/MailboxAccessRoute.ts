import { RouteDecorators } from "@rapidrest/service-core";
import { MailboxAccessRouteSQL } from "../../../src/routes/sql/MailboxAccessRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/mailboxes")
export class MailboxAccessRoute extends MailboxAccessRouteSQL {}
