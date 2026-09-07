import { RouteDecorators } from "@rapidrest/service-core";
import { TaskListRouteMongo } from "../../../src/routes/mongo/TaskListRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/task-lists")
export class TaskListRoute extends TaskListRouteMongo {}
