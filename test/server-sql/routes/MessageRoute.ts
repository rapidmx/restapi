import { RouteDecorators } from "@rapidrest/service-core";
import { MessageRouteSQL } from "../../../src/routes/sql/MessageRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/messages")
export class MessageRoute extends MessageRouteSQL {}
