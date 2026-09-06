///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    ACLAction,
    DocDecorators,
    ModelDecorators,
    PersistenceDecorators,
    RecoverableBaseMongoEntity,
} from "@rapidrest/service-core";
import { ObjectDecorators } from "@rapidrest/core";
import {
    Attendee,
    BusyStatus,
    CalendarEvent,
    CalendarEventStatus,
    Recipient,
    RecipientType,
    RecurrenceRule,
} from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Nullable } = ObjectDecorators;
const { Column, Entity, Index } = PersistenceDecorators;

/**
 * Implementation of the `CalendarEvent` interface for storage in a MongoDB database. If SQL is desired, please
 * use `models.sql.CalendarEventSQL` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("mongo")
@Entity()
@Description("Defines a single calendar event/meeting stored in a `Folder` of type `CALENDAR`.")
@Index("calevent_folder", ["folderUid"])
@Index("calevent_ical_uid", ["icalUid"])
@Protect(
    {
        uid: "CalendarEvent",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class CalendarEventMongo extends RecoverableBaseMongoEntity implements CalendarEvent {
    @Column()
    @Description("The unique identifier of the `Folder` (of type `CALENDAR`) this event resides in.")
    public folderUid: string = "";

    @Column()
    @Description("The unique identifier of the `Mailbox` this event belongs to.")
    public mailboxUid: string = "";

    @Column()
    @Description("The title of the event.")
    public title: string = "";

    @Column()
    @Description("The location of the event.")
    @Nullable
    public location?: string;

    @Column()
    @Description("The date and time the event starts.")
    public startDate: Date = new Date();

    @Column()
    @Description("The date and time the event ends.")
    public endDate: Date = new Date();

    @Column()
    @Description("`true` if the event spans the entire day rather than a specific time range.")
    public allDay: boolean = false;

    @Column()
    @Description("The IANA timezone identifier the event's start/end times were authored in.")
    public timezone: string = "";

    @Column()
    @Description("The organizer of the event.")
    public organizer: Recipient = { address: "", type: RecipientType.TO };

    @Column()
    @Description("The list of attendees invited to the event.")
    public attendees: Attendee[] = [];

    @Column()
    @Description("The recurrence definition for the event, if it repeats.")
    @Nullable
    public recurrenceRule?: RecurrenceRule;

    @Column()
    @Description(
        "For a single occurrence of a recurring event that has been individually modified, its original start date.",
    )
    @Nullable
    public recurrenceId?: Date;

    @Column()
    @Description("The scheduling status of the event.")
    public status: CalendarEventStatus = CalendarEventStatus.CONFIRMED;

    @Column()
    @Description("The free/busy status the event should be shown as.")
    public busyStatus: BusyStatus = BusyStatus.BUSY;

    @Column()
    @Description("The number of minutes before `startDate` that a reminder should be dispatched, if any.")
    @Nullable
    public reminderMinutesBeforeStart?: number;

    @Column()
    @Description(
        "A stable identifier (RFC 5545 `UID`) for this event, shared across all clients/protocols and iTIP messages.",
    )
    public icalUid: string = "";

    @Column()
    @Description("The iTIP revision counter (RFC 5546 `SEQUENCE`), incremented on every scheduling-relevant change.")
    public sequence: number = 0;

    constructor(other?: Partial<CalendarEventMongo>) {
        super(other);

        if (other) {
            this.folderUid = other.folderUid !== undefined ? other.folderUid : this.folderUid;
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.title = other.title !== undefined ? other.title : this.title;
            this.location = "location" in other ? other.location : this.location;
            this.startDate = other.startDate !== undefined ? other.startDate : this.startDate;
            this.endDate = other.endDate !== undefined ? other.endDate : this.endDate;
            this.allDay = other.allDay !== undefined ? other.allDay : this.allDay;
            this.timezone = other.timezone !== undefined ? other.timezone : this.timezone;
            this.organizer = other.organizer !== undefined ? other.organizer : this.organizer;
            this.attendees = other.attendees !== undefined ? other.attendees : this.attendees;
            this.recurrenceRule = "recurrenceRule" in other ? other.recurrenceRule : this.recurrenceRule;
            this.recurrenceId = "recurrenceId" in other ? other.recurrenceId : this.recurrenceId;
            this.status = other.status !== undefined ? other.status : this.status;
            this.busyStatus = other.busyStatus !== undefined ? other.busyStatus : this.busyStatus;
            this.reminderMinutesBeforeStart =
                "reminderMinutesBeforeStart" in other
                    ? other.reminderMinutesBeforeStart
                    : this.reminderMinutesBeforeStart;
            this.icalUid = other.icalUid !== undefined ? other.icalUid : this.icalUid;
            this.sequence = other.sequence !== undefined ? other.sequence : this.sequence;
        }
    }
}
