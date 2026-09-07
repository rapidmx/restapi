import { RouteDecorators } from "@rapidrest/service-core";
import { MailFilterRuleRouteSQL } from "../../../src/routes/sql/MailFilterRuleRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/mail-filter-rules")
export class MailFilterRuleRoute extends MailFilterRuleRouteSQL {}
