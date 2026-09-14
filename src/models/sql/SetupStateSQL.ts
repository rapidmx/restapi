///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BaseEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { SetupState } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * Implementation of the `SetupState` interface for storage in a SQL database.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@Description("Progress through the first-run setup wizard.")
@Protect(
    {
        uid: "SetupState",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class SetupStateSQL extends BaseEntity implements SetupState {
    @Column({ nullable: true })
    @Description("When an administrator first opened (or reopened) the setup wizard.")
    @Nullable
    public startedAt?: Date;

    @Column({ nullable: true })
    @Description("When an administrator finished the setup wizard.")
    @Nullable
    public completedAt?: Date;

    @Column({ nullable: true })
    @Description("The setup wizard step the administrator was last on.")
    @Nullable
    public currentStep?: string;

    constructor(other?: Partial<SetupStateSQL>) {
        super(other);

        if (other) {
            this.startedAt = "startedAt" in other ? other.startedAt : this.startedAt;
            this.completedAt = "completedAt" in other ? other.completedAt : this.completedAt;
            this.currentStep = "currentStep" in other ? other.currentStep : this.currentStep;
        }
    }
}
