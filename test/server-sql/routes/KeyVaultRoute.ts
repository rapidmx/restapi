import { RouteDecorators } from "@rapidrest/service-core";
import { KeyVaultRouteSQL } from "../../../src/routes/sql/KeyVaultRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/mailboxes")
export class KeyVaultRoute extends KeyVaultRouteSQL {}
