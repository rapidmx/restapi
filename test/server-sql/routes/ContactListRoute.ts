import { RouteDecorators } from "@rapidrest/service-core";
import { ContactListRouteSQL } from "../../../src/routes/sql/ContactListRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/contact-lists")
export class ContactListRoute extends ContactListRouteSQL {}
