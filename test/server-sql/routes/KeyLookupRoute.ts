import { RouteDecorators } from "@rapidrest/service-core";
import { KeyLookupRouteSQL } from "../../../src/routes/sql/KeyLookupRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/mailboxes")
export class KeyLookupRoute extends KeyLookupRouteSQL {}
