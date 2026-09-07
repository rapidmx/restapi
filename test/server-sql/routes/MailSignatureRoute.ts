import { RouteDecorators } from "@rapidrest/service-core";
import { MailSignatureRouteSQL } from "../../../src/routes/sql/MailSignatureRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/mail-signatures")
export class MailSignatureRoute extends MailSignatureRouteSQL {}
