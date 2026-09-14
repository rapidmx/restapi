import { RouteDecorators } from "@rapidrest/service-core";
import { MailboxPolicyRouteMongo } from "../../../src/routes/mongo/MailboxPolicyRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/mailbox-policy")
export class MailboxPolicyRoute extends MailboxPolicyRouteMongo {}
