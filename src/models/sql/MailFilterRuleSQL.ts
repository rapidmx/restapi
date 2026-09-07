///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { BaseEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { MailFilterAction, MailFilterConditions, MailFilterRule } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;

/**
 * Implementation of the `MailFilterRule` interface for storage in a SQL database. If MongoDB is desired, please
 * use `models.mongo.MailFilterRuleMongo` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@Description(
    "Defines a single mailbox-scoped inbox rule (MAPI/Outlook Rules Wizard rule) - conditions matched against " +
        "newly-delivered mail plus an ordered set of actions to take when they match.",
)
@Index("mailfilterrule_mailbox", ["mailboxUid"])
@Protect(
    {
        uid: "MailFilterRule",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class MailFilterRuleSQL extends BaseEntity implements MailFilterRule {
    @Column()
    @Description("The unique identifier of the `Mailbox` this rule belongs to.")
    public mailboxUid: string = "";

    @Column()
    @Description("The display name of the rule.")
    public name: string = "";

    @Column()
    @Description("Whether this rule is currently evaluated against newly-delivered mail.")
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
    public conditions: MailFilterConditions = {};

    @Column({ type: "simple-json" })
    @Description("The ordered actions to take once `conditions` match.")
    public actions: MailFilterAction[] = [];

    constructor(other?: Partial<MailFilterRuleSQL>) {
        super(other);

        if (other) {
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
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
