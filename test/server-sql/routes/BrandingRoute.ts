import { RouteDecorators } from "@rapidrest/service-core";
import { BrandingRouteSQL } from "../../../src/routes/sql/BrandingRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/branding")
export class BrandingRoute extends BrandingRouteSQL {}
