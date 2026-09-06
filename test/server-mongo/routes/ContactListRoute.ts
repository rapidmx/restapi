import { RouteDecorators } from "@rapidrest/service-core";
import { ContactListRouteMongo } from "../../../src/routes/mongo/ContactListRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/contact-lists")
export class ContactListRoute extends ContactListRouteMongo {}
