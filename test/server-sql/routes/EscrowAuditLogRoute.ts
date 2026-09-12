import { RouteDecorators } from "@rapidrest/service-core";
import { EscrowAuditLogRouteSQL } from "../../../src/routes/sql/EscrowAuditLogRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/escrow-audit-log")
export class EscrowAuditLogRoute extends EscrowAuditLogRouteSQL {}
