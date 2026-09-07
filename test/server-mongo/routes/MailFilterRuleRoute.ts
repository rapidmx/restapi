import { RouteDecorators } from "@rapidrest/service-core";
import { MailFilterRuleRouteMongo } from "../../../src/routes/mongo/MailFilterRuleRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/mail-filter-rules")
export class MailFilterRuleRoute extends MailFilterRuleRouteMongo {}
