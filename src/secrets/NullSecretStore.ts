///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import { SecretRef } from "../models/types.js";
import { SecretStore } from "./SecretStore.js";

/** What `NullSecretStore.write()` and `patch()` reject with (as a `400`, which a route saving credentials passes on unchanged). */
export const NO_SECRET_STORE_MESSAGE: string = "No secret store is configured, so credentials can't be saved. Deploy with OpenBao or Kubernetes Secrets.";

/** What `NullSecretStore.read()` rejects with (as a `503`: the request that needed the secret isn't at fault, the deployment is missing its store). */
export const NO_SECRET_STORE_READ_MESSAGE: string = "No secret store is configured, so saved credentials can't be read.";

/**
 * The default `SecretStore`: there is none. `@Inject("SecretStore")` has no notion of an unregistered dependency, so some class must always be registered
 * under the token. Saving is refused (400), so credentials are never kept in the database or anywhere else; reading is unavailable (503), so a consumer
 * treats the secret as unset; deleting succeeds, since nothing was ever stored here, so a row that holds a reference (from a deployment that had a store)
 * can still be removed. A caller that wants to know a delete reached nothing compares `backend` with the reference's.
 *
 * @author Jean-Philippe Steinmetz
 */
export class NullSecretStore implements SecretStore {
    public readonly backend: "none" = "none";

    public async write(_path: string, _values: Record<string, string>): Promise<SecretRef> {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, NO_SECRET_STORE_MESSAGE);
    }

    public async patch(_ref: SecretRef, _values: Record<string, string | null>): Promise<SecretRef> {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, NO_SECRET_STORE_MESSAGE);
    }

    public async read(_ref: SecretRef): Promise<Record<string, string>> {
        throw new ApiError(ApiErrors.INTERNAL_ERROR, 503, NO_SECRET_STORE_READ_MESSAGE);
    }

    public async delete(_ref: SecretRef): Promise<void> {
        // Nothing to delete: no write ever succeeded here.
    }
}
