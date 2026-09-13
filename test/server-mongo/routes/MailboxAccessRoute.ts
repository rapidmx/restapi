import { RouteDecorators } from "@rapidrest/service-core";
import { MailboxAccessRouteMongo } from "../../../src/routes/mongo/MailboxAccessRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/mailboxes")
export class MailboxAccessRoute extends MailboxAccessRouteMongo {}
