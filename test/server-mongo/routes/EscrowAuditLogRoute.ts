import { RouteDecorators } from "@rapidrest/service-core";
import { EscrowAuditLogRouteMongo } from "../../../src/routes/mongo/EscrowAuditLogRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/escrow-audit-log")
export class EscrowAuditLogRoute extends EscrowAuditLogRouteMongo {}
