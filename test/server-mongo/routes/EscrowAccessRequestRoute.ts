import { RouteDecorators } from "@rapidrest/service-core";
import { EscrowAccessRequestRouteMongo } from "../../../src/routes/mongo/EscrowAccessRequestRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/escrow-access-requests")
export class EscrowAccessRequestRoute extends EscrowAccessRequestRouteMongo {}
