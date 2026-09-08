import { RouteDecorators } from "@rapidrest/service-core";
import { AuditLogRouteMongo } from "../../../src/routes/mongo/AuditLogRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/audit-logs")
export class AuditLogRoute extends AuditLogRouteMongo {}
