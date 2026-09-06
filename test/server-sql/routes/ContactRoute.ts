import { RouteDecorators } from "@rapidrest/service-core";
import { ContactRouteSQL } from "../../../src/routes/sql/ContactRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/contacts")
export class ContactRoute extends ContactRouteSQL {}
