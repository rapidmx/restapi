import { RouteDecorators } from "@rapidrest/service-core";
import { AttachmentRouteSQL } from "../../../src/routes/sql/AttachmentRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/attachments")
export class AttachmentRoute extends AttachmentRouteSQL {}
