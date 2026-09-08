import { RouteDecorators } from "@rapidrest/service-core";
import { FocusedInboxOverrideRouteMongo } from "../../../src/routes/mongo/FocusedInboxOverrideRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/focused-inbox-overrides")
export class FocusedInboxOverrideRoute extends FocusedInboxOverrideRouteMongo {}
