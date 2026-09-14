import { RouteDecorators } from "@rapidrest/service-core";
import { MailboxPolicyRouteSQL } from "../../../src/routes/sql/MailboxPolicyRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/mailbox-policy")
export class MailboxPolicyRoute extends MailboxPolicyRouteSQL {}
