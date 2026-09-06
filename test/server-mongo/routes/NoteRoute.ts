import { RouteDecorators } from "@rapidrest/service-core";
import { NoteRouteMongo } from "../../../src/routes/mongo/NoteRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/notes")
export class NoteRoute extends NoteRouteMongo {}
