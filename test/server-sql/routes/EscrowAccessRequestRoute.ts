import { RouteDecorators } from "@rapidrest/service-core";
import { EscrowAccessRequestRouteSQL } from "../../../src/routes/sql/EscrowAccessRequestRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/escrow-access-requests")
export class EscrowAccessRequestRoute extends EscrowAccessRequestRouteSQL {}
