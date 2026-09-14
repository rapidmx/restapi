///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// A backend-neutral way for a shared route suite to seed and inspect rows directly, bypassing the routes under test.
// `kind` is an entity name without its backend suffix ("Matter" for MatterSQL/MatterMongo).
export interface EntityStore {
    backend: "sql" | "mongo";
    /** Constructs the backend's entity class from `data` and saves it, returning the saved row. */
    save(kind: string, data: any): Promise<any>;
    find(kind: string, where?: any): Promise<any[]>;
    /** Writes `patch` over the stored row directly. */
    update(kind: string, uid: string, patch: any): Promise<void>;
    clear(...kinds: string[]): Promise<void>;
    /** Saves an `AccessControlList` row. */
    saveAcl(uid: string, parentUid: string, records: any[]): Promise<void>;
}
