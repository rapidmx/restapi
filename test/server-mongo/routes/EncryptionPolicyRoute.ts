import { RouteDecorators } from "@rapidrest/service-core";
import { EncryptionPolicyRouteMongo } from "../../../src/routes/mongo/EncryptionPolicyRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/encryption-policy")
export class EncryptionPolicyRoute extends EncryptionPolicyRouteMongo {}
