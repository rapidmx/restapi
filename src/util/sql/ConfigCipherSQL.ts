///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ConfigKeyStateSQL } from "../../models/sql/ConfigKeyStateSQL.js";
import { ConfigCipher } from "../../secrets/ConfigCipher.js";

/** The `ConfigCipher` for a SQL deployment: it reads the active kid from `ConfigKeyStateSQL`. */
export class ConfigCipherSQL extends ConfigCipher {
    protected configKeyStateClass: any = ConfigKeyStateSQL;
}
