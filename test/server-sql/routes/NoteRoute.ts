import { RouteDecorators } from "@rapidrest/service-core";
import { NoteRouteSQL } from "../../../src/routes/sql/NoteRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/notes")
export class NoteRoute extends NoteRouteSQL {}
