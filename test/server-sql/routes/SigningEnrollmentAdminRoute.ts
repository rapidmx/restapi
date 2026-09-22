import { RouteDecorators } from "@rapidrest/service-core";
import { SigningEnrollmentAdminRouteSQL } from "../../../src/routes/sql/SigningEnrollmentAdminRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/signing-enrollments-admin")
export class SigningEnrollmentAdminRoute extends SigningEnrollmentAdminRouteSQL {}
