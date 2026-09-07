import { RouteDecorators } from "@rapidrest/service-core";
import { TaskListRouteSQL } from "../../../src/routes/sql/TaskListRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/task-lists")
export class TaskListRoute extends TaskListRouteSQL {}
