///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";

/**
 * Dynamically imports the optional peer dependency `@aws-sdk/client-s3`, throwing a helpful
 * error if it is not installed.
 */
export const importAwsClientS3 = async function (): Promise<any> {
    try {
        return await import("@aws-sdk/client-s3");
    } catch (err: any) {
        throw new ApiError(
            ApiErrors.INTERNAL_ERROR,
            500,
            "This feature requires the optional peer dependency '@aws-sdk/client-s3'. Install it with: " +
                "yarn add @aws-sdk/client-s3",
        );
    }
};

/**
 * Dynamically imports the optional peer dependency `@aws-sdk/client-ses`, throwing a helpful
 * error if it is not installed.
 */
export const importAwsClientSES = async function (): Promise<any> {
    try {
        return await import("@aws-sdk/client-ses");
    } catch (err: any) {
        throw new ApiError(
            ApiErrors.INTERNAL_ERROR,
            500,
            "This feature requires the optional peer dependency '@aws-sdk/client-ses'. Install it with: " +
                "yarn add @aws-sdk/client-ses",
        );
    }
};

/**
 * Dynamically imports the optional peer dependency `@aws-sdk/client-sesv2`, throwing a helpful
 * error if it is not installed.
 */
export const importAwsClientSESv2 = async function (): Promise<any> {
    try {
        return await import("@aws-sdk/client-sesv2");
    } catch (err: any) {
        throw new ApiError(
            ApiErrors.INTERNAL_ERROR,
            500,
            "This feature requires the optional peer dependency '@aws-sdk/client-sesv2'. Install it with: " +
                "yarn add @aws-sdk/client-sesv2",
        );
    }
};
