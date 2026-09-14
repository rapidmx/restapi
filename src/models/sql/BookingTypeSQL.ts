///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BaseEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { BookingAvailabilityWindow, BookingDateOverride, BookingType } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * Implementation of the `BookingType` interface for storage in a SQL database. If MongoDB is desired, please
 * use `models.mongo.BookingTypeMongo` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@Description("A bookable offering owned by a mailbox that an anonymous visitor can pick an appointment slot from.")
@Index("bookingtype_slug", ["slug"], { unique: true })
@Index("bookingtype_mailbox", ["mailboxUid"])
@Protect(
    {
        uid: "BookingType",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class BookingTypeSQL extends BaseEntity implements BookingType {
    @Column()
    @Description("The unique identifier of the `Mailbox` that owns this booking type.")
    public mailboxUid: string = "";

    @Column()
    @Description("The unique identifier of the `Folder` (of type CALENDAR) bookings are written into.")
    public calendarFolderUid: string = "";

    @Column()
    @Description("The globally unique, URL-safe public identifier for this booking type.")
    public slug: string = "";

    @Column()
    @Description("The public-facing name of the offering.")
    public name: string = "";

    @Column({ type: "text", nullable: true })
    @Description("A longer public-facing description of the offering.")
    @Nullable
    public description?: string;

    @Column()
    @Description("The host's name as shown to an anonymous booker.")
    public hostDisplayName: string = "";

    @Column()
    @Description("How long a single booking lasts, in minutes.")
    public durationMinutes: number = 30;

    @Column()
    @Description("The IANA timezone identifier availability/dateOverrides are authored in.")
    public timezone: string = "UTC";

    @Column({ type: "simple-json" })
    @Description("The recurring weekly windows this type can be booked in.")
    public availability: BookingAvailabilityWindow[] = [];

    @Column({ type: "simple-json" })
    @Description("Per-date replacements for availability. An empty windows array is a blackout day.")
    public dateOverrides: BookingDateOverride[] = [];

    @Column({ nullable: true })
    @Description("How far apart consecutive candidate slot starts are, in minutes. Defaults to durationMinutes.")
    @Nullable
    public slotIntervalMinutes?: number;

    @Column()
    @Description("Padding kept clear immediately before a booking, in minutes.")
    public bufferBeforeMinutes: number = 0;

    @Column()
    @Description("Padding kept clear immediately after a booking, in minutes.")
    public bufferAfterMinutes: number = 0;

    @Column()
    @Description("The minimum lead time, in minutes, between now and a bookable slot's start.")
    public minimumNoticeMinutes: number = 0;

    @Column()
    @Description("How far into the future slots are offered, in days from now.")
    public bookingWindowDays: number = 60;

    @Column({ nullable: true })
    @Description("The maximum number of non-cancelled bookings allowed on any single local date.")
    @Nullable
    public maxPerDay?: number;

    @Column()
    @Description("When true, a new booking lands as PENDING with a TENTATIVE event for the host to confirm.")
    public requiresApproval: boolean = false;

    @Column()
    @Description("When false, the public endpoints behave as though this booking type does not exist.")
    public enabled: boolean = true;

    constructor(other?: Partial<BookingTypeSQL>) {
        super(other);

        if (other) {
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.calendarFolderUid = other.calendarFolderUid !== undefined ? other.calendarFolderUid : this.calendarFolderUid;
            this.slug = other.slug !== undefined ? other.slug : this.slug;
            this.name = other.name !== undefined ? other.name : this.name;
            this.description = "description" in other ? other.description : this.description;
            this.hostDisplayName = other.hostDisplayName !== undefined ? other.hostDisplayName : this.hostDisplayName;
            this.durationMinutes = other.durationMinutes !== undefined ? other.durationMinutes : this.durationMinutes;
            this.timezone = other.timezone !== undefined ? other.timezone : this.timezone;
            this.availability = other.availability !== undefined ? other.availability : this.availability;
            this.dateOverrides = other.dateOverrides !== undefined ? other.dateOverrides : this.dateOverrides;
            this.slotIntervalMinutes = "slotIntervalMinutes" in other ? other.slotIntervalMinutes : this.slotIntervalMinutes;
            this.bufferBeforeMinutes = other.bufferBeforeMinutes !== undefined ? other.bufferBeforeMinutes : this.bufferBeforeMinutes;
            this.bufferAfterMinutes = other.bufferAfterMinutes !== undefined ? other.bufferAfterMinutes : this.bufferAfterMinutes;
            this.minimumNoticeMinutes = other.minimumNoticeMinutes !== undefined ? other.minimumNoticeMinutes : this.minimumNoticeMinutes;
            this.bookingWindowDays = other.bookingWindowDays !== undefined ? other.bookingWindowDays : this.bookingWindowDays;
            this.maxPerDay = "maxPerDay" in other ? other.maxPerDay : this.maxPerDay;
            this.requiresApproval = other.requiresApproval !== undefined ? other.requiresApproval : this.requiresApproval;
            this.enabled = other.enabled !== undefined ? other.enabled : this.enabled;
        }
    }
}
