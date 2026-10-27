///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { BaseEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { DeploymentIdentity } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity } = PersistenceDecorators;

/**
 * Implementation of the `DeploymentIdentity` interface for storage in a SQL database.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@Description("This deployment's own identity, created once and never changed.")
@Protect(
    {
        uid: "DeploymentIdentity",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class DeploymentIdentitySQL extends BaseEntity implements DeploymentIdentity {
    @Column()
    @Description("The stable part of the external-dns owner id: 16 random lowercase letters and digits.")
    public installationId: string = "";

    constructor(other?: Partial<DeploymentIdentitySQL>) {
        super(other);

        if (other) {
            this.installationId = other.installationId !== undefined ? other.installationId : this.installationId;
        }
    }
}
