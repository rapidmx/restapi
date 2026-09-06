import { RouteDecorators } from "@rapidrest/service-core";
import { ContactRouteMongo } from "../../../src/routes/mongo/ContactRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/contacts")
export class ContactRoute extends ContactRouteMongo {}
