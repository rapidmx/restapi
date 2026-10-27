import { RouteDecorators } from "@rapidrest/service-core";
import { ConfigKeyRouteMongo } from "../../../src/routes/mongo/ConfigKeyRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/config-keys")
export class ConfigKeyRoute extends ConfigKeyRouteMongo {}
