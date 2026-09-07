import { RouteDecorators } from "@rapidrest/service-core";
import { MailSignatureRouteMongo } from "../../../src/routes/mongo/MailSignatureRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/mail-signatures")
export class MailSignatureRoute extends MailSignatureRouteMongo {}
