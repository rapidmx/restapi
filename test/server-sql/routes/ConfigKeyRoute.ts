import { RouteDecorators } from "@rapidrest/service-core";
import { ConfigKeyRouteSQL } from "../../../src/routes/sql/ConfigKeyRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/config-keys")
export class ConfigKeyRoute extends ConfigKeyRouteSQL {}
