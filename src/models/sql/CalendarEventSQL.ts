///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    ACLAction,
    DocDecorators,
    ModelDecorators,
    PersistenceDecorators,
    RecoverableBaseEntity,
} from "@rapidrest/service-core";
import { ObjectDecorators } from "@rapidrest/core";
import {
    Attendee,
    BusyStatus,
    CalendarEvent,
    CalendarEventStatus,
    EncryptionOrigin,
    EventVisibility,
    Recipient,
    RecipientType,
    RecurrenceRule,
} from "../types.js";
import { boundIndexedValue } from "../../util/ConversationUtils.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Nullable } = ObjectDecorators;
const { Column, Entity, Index } = PersistenceDecorators;

/**
 * Implementation of the `CalendarEvent` interface for storage in a SQL database. If MongoDB is desired, please
 * use `models.mongo.CalendarEventMongo` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@Description("Defines a single calendar event/meeting stored in a `Folder` of type `CALENDAR`.")
@Index("calevent_folder", ["folderUid"])
@Index("calevent_ical_uid", ["icalUid"])
@Index("calevent_mailbox", ["mailboxUid"])
@Index("calevent_folder_modified", ["folderUid", "dateModified", "uid"])
@Index("calevent_mailbox_modified", ["mailboxUid", "dateModified", "uid"])
@Index("calevent_start_date", ["startDate"])
@Index("calevent_status", ["status"])
@Index("calevent_cancel_notice_sent_at", ["cancelNoticeSentAt"])
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
export class CalendarEventSQL extends RecoverableBaseEntity implements CalendarEvent {
    @Column()
    @Description("The unique identifier of the `Folder` (of type `CALENDAR`) this event resides in.")
    public folderUid: string = "";

    @Column()
    @Description("The unique identifier of the `Mailbox` this event belongs to.")
    public mailboxUid: string = "";

    @Column({ type: "text" })
    @Description("The title of the event.")
    public title: string = "";

    @Column({ type: "text", nullable: true })
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

    // `text`: taken from inbound iTIP/ICS data (TZID) and unindexed - a plain string column is `varchar(255)` on MySQL,
    // which rejects a longer value and fails the import.
    @Column({ type: "text" })
    @Description("The IANA timezone identifier the event's start/end times were authored in.")
    public timezone: string = "";

    @Column({ type: "simple-json" })
    @Description("The organizer of the event.")
    public organizer: Recipient = { address: "", type: RecipientType.TO };

    @Column({ type: "simple-json" })
    @Description("The list of attendees invited to the event.")
    public attendees: Attendee[] = [];

    @Column({ type: "simple-json", nullable: true })
    @Description("The recurrence definition for the event, if it repeats.")
    @Nullable
    public recurrenceRule?: RecurrenceRule;

    @Column({ nullable: true })
    @Description(
        "For a single occurrence of a recurring event that has been individually modified, its original start date.",
    )
    @Nullable
    public recurrenceId?: Date;

    // `type: "varchar"` is required on every enum-typed column: TypeScript's `emitDecoratorMetadata` reflects
    // a string enum's design type as the enum object itself, not a primitive constructor, which TypeORM/
    // better-sqlite3 cannot resolve into a column type on its own (it would otherwise fail at
    // `DataSource.initialize()` with "Data type 'undefined' ... is not supported").
    @Column({ type: "varchar" })
    @Description("The scheduling status of the event.")
    public status: CalendarEventStatus = CalendarEventStatus.CONFIRMED;

    @Column({ type: "varchar" })
    @Description("The free/busy status the event should be shown as.")
    public busyStatus: BusyStatus = BusyStatus.BUSY;

    @Column({ nullable: true })
    @Description("The number of minutes before `startDate` that a reminder should be dispatched, if any.")
    @Nullable
    public reminderMinutesBeforeStart?: number;

    @Column()
    @Description(
        "A stable identifier (RFC 5545 `UID`) for this event, shared across all clients/protocols and iTIP messages. " +
            "A value longer than 255 characters is stored as `sha256:<hex>` of the original.",
    )
    public icalUid: string = "";

    @Column()
    @Description("The iTIP revision counter (RFC 5546 `SEQUENCE`), incremented on every scheduling-relevant change.")
    public sequence: number = 0;

    @Column({ nullable: true })
    @Description(
        "When `true`, this event's own start/end window independently triggers an automatic-reply period for " +
            "the mailbox, in addition to the mailbox-level `Mailbox.oofEnabled` toggle.",
    )
    @Nullable
    public autoReplyEnabled?: boolean;

    @Column({ type: "text", nullable: true })
    @Description("The automatic-reply body to use while this event's window is active.")
    @Nullable
    public autoReplyMessage?: string;

    @Column({ nullable: true })
    @Description(
        "The `sequence` value as of the last time invites were successfully sent to attendees. " +
            "`undefined` means never invited.",
    )
    @Nullable
    public inviteSequenceSent?: number;

    @Column({ nullable: true })
    @Description("Set once an iTIP CANCEL has been sent to attendees for this event.")
    @Nullable
    public cancelNoticeSentAt?: Date;

    @Column({ nullable: true })
    @Description("The start of the latest occurrence whose reminder has been sent (system-managed).")
    @Nullable
    public reminderSentFor?: Date;

    // `nullable: true`: added after the table already existed in deployed installations, and this framework's
    // `@Column` decorator has no SQL-level `DEFAULT` option (see `ColumnOptions`) - without `nullable: true`,
    // `synchronize: true`'s `ALTER TABLE ... ADD COLUMN ... NOT NULL` fails outright against a populated table
    // on Postgres/MySQL. A legacy row's `NULL` is coalesced to `"none"` by the constructor below, same as this
    // field's intended default. `type: "varchar"` is required for the same reason as `status` above (see its
    // own note) - a string-literal-union column TypeORM can't infer a type for on its own.
    @Column({ type: "varchar", nullable: true })
    @Description("Provenance for this event's encryption state - see EncryptionOrigin's own doc comment.")
    public encryptionOrigin: EncryptionOrigin = "none";

    // Not indexed: nothing ever queries by this field - `MeetingSchedulingJob` only reads it off rows it has
    // already loaded, to decide whether that one event's invites need per-attendee personalization.
    // `nullable: true` for the same reason as `encryptionOrigin` above: added after the table already existed.
    @Column({ nullable: true })
    @Description(
        "The identifier of the video meeting a compose client linked to this event, if any (e.g. a " +
            "`@rapidmx/meet-plugin` `VideoMeeting.uid`). No foreign-key enforcement.",
    )
    @Nullable
    public videoMeetingUid?: string;

    // `text`, `nullable: true`: unbounded by the column type (the route bounds them) and added after the table already existed.
    @Column({ type: "text", nullable: true })
    @Description(
        "The description of the event as plain text (at most 32,000 characters). The plain-text form of `descriptionHtml` when only " +
            "the HTML is written.",
    )
    @Nullable
    public description?: string;

    @Column({ type: "text", nullable: true })
    @Description(
        "The description of the event as HTML, sanitized by the server on every write (only b/strong, i/em, u, br, p, ul/ol/li and " +
            "a with an http, https or mailto href survive; at most 64,000 characters).",
    )
    @Nullable
    public descriptionHtml?: string;

    // `nullable: true` on this and the three booleans below, for the reason `encryptionOrigin` gives above: added after the table already
    // existed in deployed installations, and `@Column` has no SQL-level `DEFAULT`. A legacy row's `NULL` reads as the field's default
    // everywhere it matters (`util/CalendarEventUtils.ts`). `type: "varchar"` for a string-literal-union column, as `status` above.
    @Column({ type: "varchar", nullable: true })
    @Description(
        "Who may see the event's details: `default`, `public`, `private` or `confidential` (iCalendar CLASS). A reader of the " +
            "calendar who is not its owner or a delegate with UPDATE sees a private or confidential event only as a busy block.",
    )
    @Nullable
    public visibility: EventVisibility = "default";

    @Column({ nullable: true })
    @Description("Whether the guests may ask the organizer to change the event (X-RAPIDMX-GUESTS-CAN-MODIFY).")
    @Nullable
    public guestsCanModify: boolean = false;

    @Column({ nullable: true })
    @Description("Whether the guests may ask the organizer to add other guests (X-RAPIDMX-GUESTS-CAN-INVITE).")
    @Nullable
    public guestsCanInviteOthers: boolean = true;

    @Column({ nullable: true })
    @Description(
        "Whether a guest may see who else was invited (X-RAPIDMX-GUESTS-CAN-SEE-GUEST-LIST). When `false` each guest is mailed an " +
            "invitation naming only themselves.",
    )
    @Nullable
    public guestsCanSeeGuestList: boolean = true;

    constructor(other?: Partial<CalendarEventSQL>) {
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
            this.icalUid = other.icalUid !== undefined ? boundIndexedValue(other.icalUid) : this.icalUid;
            this.sequence = other.sequence !== undefined ? other.sequence : this.sequence;
            this.autoReplyEnabled = "autoReplyEnabled" in other ? other.autoReplyEnabled : this.autoReplyEnabled;
            this.autoReplyMessage = "autoReplyMessage" in other ? other.autoReplyMessage : this.autoReplyMessage;
            this.inviteSequenceSent = "inviteSequenceSent" in other ? other.inviteSequenceSent : this.inviteSequenceSent;
            this.cancelNoticeSentAt = "cancelNoticeSentAt" in other ? other.cancelNoticeSentAt : this.cancelNoticeSentAt;
            this.reminderSentFor = "reminderSentFor" in other ? other.reminderSentFor : this.reminderSentFor;
            this.encryptionOrigin = other.encryptionOrigin !== undefined ? other.encryptionOrigin : this.encryptionOrigin;
            this.videoMeetingUid = "videoMeetingUid" in other ? other.videoMeetingUid : this.videoMeetingUid;
            this.description = "description" in other ? other.description : this.description;
            this.descriptionHtml = "descriptionHtml" in other ? other.descriptionHtml : this.descriptionHtml;
            this.visibility = other.visibility !== undefined ? other.visibility : this.visibility;
            this.guestsCanModify = other.guestsCanModify !== undefined ? other.guestsCanModify : this.guestsCanModify;
            this.guestsCanInviteOthers =
                other.guestsCanInviteOthers !== undefined ? other.guestsCanInviteOthers : this.guestsCanInviteOthers;
            this.guestsCanSeeGuestList =
                other.guestsCanSeeGuestList !== undefined ? other.guestsCanSeeGuestList : this.guestsCanSeeGuestList;
        }
    }
}
