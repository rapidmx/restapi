///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { BaseEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { TransportRule, TransportRuleAction, TransportRuleConditions } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity } = PersistenceDecorators;

/**
 * Implementation of the `TransportRule` interface for storage in a SQL database. If MongoDB is desired,
 * please use `models.mongo.TransportRuleMongo` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@Description(
    "Defines a single org-wide, admin-managed mail-flow rule - conditions matched against every message " +
        "crossing this mail system, plus an ordered set of actions to take when they match.",
)
@Protect(
    {
        uid: "TransportRule",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class TransportRuleSQL extends BaseEntity implements TransportRule {
    @Column()
    @Description("The display name of the rule.")
    public name: string = "";

    @Column()
    @Description("Whether this rule is currently evaluated against every message crossing this mail system.")
    public enabled: boolean = true;

    @Column()
    @Description("Evaluation order, ascending.")
    public sequence: number = 0;

    @Column()
    @Description(
        "When `true` and this rule matches, no rule with a higher `sequence` is evaluated for the same message.",
    )
    public stopProcessingRules: boolean = false;

    @Column({ type: "simple-json" })
    @Description("The match criteria that must hold for this rule's actions to run.")
    public conditions: TransportRuleConditions = {};

    @Column({ type: "simple-json" })
    @Description("The ordered actions to take once `conditions` match.")
    public actions: TransportRuleAction[] = [];

    constructor(other?: Partial<TransportRuleSQL>) {
        super(other);

        if (other) {
            this.name = other.name !== undefined ? other.name : this.name;
            this.enabled = other.enabled !== undefined ? other.enabled : this.enabled;
            this.sequence = other.sequence !== undefined ? other.sequence : this.sequence;
            this.stopProcessingRules =
                other.stopProcessingRules !== undefined ? other.stopProcessingRules : this.stopProcessingRules;
            this.conditions = other.conditions !== undefined ? other.conditions : this.conditions;
            this.actions = other.actions !== undefined ? other.actions : this.actions;
        }
    }
}
