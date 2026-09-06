import { RouteDecorators } from "@rapidrest/service-core";
import { AttachmentRouteMongo } from "../../../src/routes/mongo/AttachmentRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/attachments")
export class AttachmentRoute extends AttachmentRouteMongo {}
