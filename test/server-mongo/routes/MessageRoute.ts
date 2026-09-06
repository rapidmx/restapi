import { RouteDecorators } from "@rapidrest/service-core";
import { MessageRouteMongo } from "../../../src/routes/mongo/MessageRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/messages")
export class MessageRoute extends MessageRouteMongo {}
