import { RouteDecorators } from "@rapidrest/service-core";
import { SigningEnrollmentAdminRouteMongo } from "../../../src/routes/mongo/SigningEnrollmentAdminRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/signing-enrollments-admin")
export class SigningEnrollmentAdminRoute extends SigningEnrollmentAdminRouteMongo {}
