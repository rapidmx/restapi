import { RouteDecorators } from "@rapidrest/service-core";
import { KeyLookupRouteMongo } from "../../../src/routes/mongo/KeyLookupRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/mailboxes")
export class KeyLookupRoute extends KeyLookupRouteMongo {}
