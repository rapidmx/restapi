import { RouteDecorators } from "@rapidrest/service-core";
import { AuditLogRouteSQL } from "../../../src/routes/sql/AuditLogRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/audit-logs")
export class AuditLogRoute extends AuditLogRouteSQL {}
