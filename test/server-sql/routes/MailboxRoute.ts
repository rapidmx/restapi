import { RouteDecorators } from "@rapidrest/service-core";
import { MailboxRouteSQL } from "../../../src/routes/sql/MailboxRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/mailboxes")
export class MailboxRoute extends MailboxRouteSQL {}
