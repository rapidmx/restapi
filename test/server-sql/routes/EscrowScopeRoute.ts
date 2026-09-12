import { RouteDecorators } from "@rapidrest/service-core";
import { EscrowScopeRouteSQL } from "../../../src/routes/sql/EscrowScopeRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/escrow-scopes")
export class EscrowScopeRoute extends EscrowScopeRouteSQL {}
