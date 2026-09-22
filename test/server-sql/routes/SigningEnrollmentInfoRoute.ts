import { RouteDecorators } from "@rapidrest/service-core";
import { SigningEnrollmentInfoRouteSQL } from "../../../src/routes/sql/SigningEnrollmentInfoRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/signing-enrollment-info")
export class SigningEnrollmentInfoRoute extends SigningEnrollmentInfoRouteSQL {}
