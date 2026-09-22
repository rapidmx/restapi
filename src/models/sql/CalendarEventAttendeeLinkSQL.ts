///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ACLAction, BaseEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { ObjectDecorators } from "@rapidrest/core";
import { CalendarEventAttendeeLink } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Nullable } = ObjectDecorators;
const { Column, Entity, Index } = PersistenceDecorators;

/**
 * Implementation of the `CalendarEventAttendeeLink` interface for storage in a SQL database. If MongoDB is
 * desired, please use `models.mongo.CalendarEventAttendeeLinkMongo` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@Description(
    "One attendee's own personalized link for one `CalendarEvent`, written by a plugin and substituted into " +
        "that attendee's own copy of the invite by `MeetingSchedulingJob`.",
)
@Index("caleventattendeelink_calendar_event", ["calendarEventUid"])
@Index("caleventattendeelink_mailbox", ["mailboxUid"])
@Protect(
    {
        uid: "CalendarEventAttendeeLink",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class CalendarEventAttendeeLinkSQL extends BaseEntity implements CalendarEventAttendeeLink {
    @Column()
    @Description("The unique identifier of the `Mailbox` that owns the `CalendarEvent` this link applies to.")
    public mailboxUid: string = "";

    @Column()
    @Description("The `CalendarEvent.uid` this personalization applies to.")
    public calendarEventUid: string = "";

    @Column()
    @Description("The attendee's own address, normalized (trimmed, lowercased).")
    public attendeeAddress: string = "";

    // `text`: a personalized join URL carries a per-invitee token and can comfortably exceed the 255 characters
    // a plain string column gets on MySQL, and nothing ever queries or indexes it.
    @Column({ type: "text" })
    @Description("The personalized URL this attendee's own copy of the invite should carry.")
    public url: string = "";

    @Column({ nullable: true })
    @Description("An optional short label for `url` (e.g. `Join video call`).")
    @Nullable
    public label?: string;

    constructor(other?: Partial<CalendarEventAttendeeLinkSQL>) {
        super(other);

        if (other) {
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.calendarEventUid = other.calendarEventUid !== undefined ? other.calendarEventUid : this.calendarEventUid;
            this.attendeeAddress = other.attendeeAddress !== undefined ? other.attendeeAddress : this.attendeeAddress;
            this.url = other.url !== undefined ? other.url : this.url;
            this.label = "label" in other ? other.label : this.label;
        }
    }
}
