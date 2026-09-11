import { RouteDecorators } from "@rapidrest/service-core";
import { KeyVaultRouteMongo } from "../../../src/routes/mongo/KeyVaultRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/mailboxes")
export class KeyVaultRoute extends KeyVaultRouteMongo {}
