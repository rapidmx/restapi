import { RouteDecorators } from "@rapidrest/service-core";
import { SigningEnrollmentInfoRouteMongo } from "../../../src/routes/mongo/SigningEnrollmentInfoRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/signing-enrollment-info")
export class SigningEnrollmentInfoRoute extends SigningEnrollmentInfoRouteMongo {}
