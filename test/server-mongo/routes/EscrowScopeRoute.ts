import { RouteDecorators } from "@rapidrest/service-core";
import { EscrowScopeRouteMongo } from "../../../src/routes/mongo/EscrowScopeRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/escrow-scopes")
export class EscrowScopeRoute extends EscrowScopeRouteMongo {}
