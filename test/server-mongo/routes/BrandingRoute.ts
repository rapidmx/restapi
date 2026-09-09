import { RouteDecorators } from "@rapidrest/service-core";
import { BrandingRouteMongo } from "../../../src/routes/mongo/BrandingRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/branding")
export class BrandingRoute extends BrandingRouteMongo {}
