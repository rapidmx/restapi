import { RouteDecorators } from "@rapidrest/service-core";
import { TaskRouteMongo } from "../../../src/routes/mongo/TaskRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/tasks")
export class TaskRoute extends TaskRouteMongo {}
