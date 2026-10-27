///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ConfigKeyStateMongo } from "../../models/mongo/ConfigKeyStateMongo.js";
import { ConfigCipher } from "../../secrets/ConfigCipher.js";

/** The `ConfigCipher` for a MongoDB deployment: it reads the active kid from `ConfigKeyStateMongo`. */
export class ConfigCipherMongo extends ConfigCipher {
    protected configKeyStateClass: any = ConfigKeyStateMongo;
}
