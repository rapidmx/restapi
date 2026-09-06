import { RouteDecorators } from "@rapidrest/service-core";
import { MailboxRouteMongo } from "../../../src/routes/mongo/MailboxRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/mailboxes")
export class MailboxRoute extends MailboxRouteMongo {}
