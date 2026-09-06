import { RouteDecorators } from "@rapidrest/service-core";
import { TaskRouteSQL } from "../../../src/routes/sql/TaskRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/tasks")
export class TaskRoute extends TaskRouteSQL {}
