import { RouteDecorators } from "@rapidrest/service-core";
import { EncryptionPolicyRouteSQL } from "../../../src/routes/sql/EncryptionPolicyRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/encryption-policy")
export class EncryptionPolicyRoute extends EncryptionPolicyRouteSQL {}
