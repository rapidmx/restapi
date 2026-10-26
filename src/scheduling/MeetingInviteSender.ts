///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { ObjectDecorators } from "@rapidrest/core";
import { ModelUtils, type RepoUtils } from "@rapidrest/service-core";
import type { BlobStore } from "../blob/BlobStore.js";
import { ScanPipeline } from "../scan/ScanPipeline.js";
import { normalizeAddress } from "../util/AddressUtils.js";
import { guestPermissionsOf } from "../util/CalendarEventUtils.js";
import { buildEventIcs } from "../util/IcsUtils.js";
import { scanAndRelay } from "../util/MailSendUtils.js";
import { isPlainAddress, safeDisplayName } from "../util/MimeHeaderUtils.js";
import { sendOrThrow } from "../transport/TransportResultUtils.js";
import type { MailTransport, OutboundMessage, TransportResult } from "../transport/MailTransport.js";
import { isSealedEvent } from "../zeroaccess/ZeroAccessFieldSealer.js";
import { CalendarEventStatus, type Attendee, type CalendarEvent, type CalendarEventAttendeeLink } from "../models/types.js";
const { Config, Inject, Logger } = ObjectDecorators;

/** The plaintext title, location and description a protected event's invitations are composed with (`sendProtectedInvitations()`). */
export interface InvitationContent {
    title: string;
    location?: string;
    description?: string;
    descriptionHtml?: string;
}

/** Per attendee (normalized address), the `#` part of their join link to a meeting protected by a per-meeting key: `k=` and the key
 * (meet-plugin `specs/meeting_privacy.md` §4.1). Supplied by the organizer's client with a save that invites; never stored. */
export type MeetingLinkSecrets = Record<string, string>;

/** What one link's `#` part may be. */
const MEETING_LINK_SECRET = /^k=[A-Za-z0-9_-]{16,1024}$/;

/** `value` (a request's `meetingLinkSecrets`) as `MeetingLinkSecrets`: the well-formed entries for plain addresses, at most `max` of
 * them - `undefined` when there are none. */
export function meetingLinkSecretsOf(value: unknown, max: number = 500): MeetingLinkSecrets | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    const secrets: MeetingLinkSecrets = {};
    for (const [address, secret] of Object.entries(value as Record<string, unknown>).slice(0, max)) {
        if (typeof secret === "string" && MEETING_LINK_SECRET.test(secret) && isPlainAddress(address)) {
            secrets[normalizeAddress(address)] = secret;
        }
    }
    return Object.keys(secrets).length > 0 ? secrets : undefined;
}

/** Whether `event`'s current revision's invitations are still to be sent: it has attendees, isn't cancelled, and its `sequence` hasn't
 * been sent yet. */
export function invitationsPending(event: CalendarEvent): boolean {
    if (!event.attendees?.length || event.status === CalendarEventStatus.CANCELLED) {
        return false;
    }
    return event.inviteSequenceSent === undefined || event.inviteSequenceSent === null || event.inviteSequenceSent !== event.sequence;
}

/** Whether `event`'s content is sealed (`isSealedEvent()`: of a calendar zero-access encryption protects, or filed from a zero-access
 * invitation) and its current revision's invitations are still to be sent. */
export function protectedInvitationsPending(event: CalendarEvent): boolean {
    return isSealedEvent(event) && invitationsPending(event);
}

/** The organizer's mailbox as an invitation is sent from it: the addresses it may organize as, and its display name. */
export interface MailboxIdentity {
    addresses: Set<string>;
    displayName?: string;
}

/**
 * Composes and sends a calendar event's iTIP `REQUEST`s and `CANCEL`s to its attendees, as its organizer's mailbox. Used by
 * `MeetingSchedulingJob`, which sends them for stored events, and by the routes that must send them while they still hold the plaintext of
 * a request - an event of a calendar zero-access encryption protects is stored with its title sealed (`specs/search.md` §3 *What It
 * Covers*), so it can't be composed later.
 */
export class MeetingInviteSender {
    @Inject("MailTransport")
    private mailTransport?: MailTransport;

    @Inject(ScanPipeline)
    private scanPipeline?: ScanPipeline;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    @Logger
    private ownLogger?: any;

    @Config("mail:jobs:meeting_scheduling:max_attendees", 500)
    private ownMaxAttendees: number = 500;

    /** `host`: what sends through this (`MeetingSchedulingJob`), whose logger and attendee cap it uses when given; and, for a sender of
     * keyed meetings, whether an attendee's copy may carry their link's key (`mayCarryMeetingKey`, see `sendPerAttendee()`; without it no
     * copy does). Build one per caller (no `name` to `ObjectFactory.newInstance()`): a named one is shared, `host` and all. */
    constructor(
        private readonly mailboxRepo: RepoUtils<any> | undefined,
        private readonly attendeeLinkRepo: RepoUtils<any> | undefined,
        private readonly host?: { logger?: any; maxAttendees?: number; mayCarryMeetingKey?: (address: string) => Promise<boolean> },
    ) {}

    private get logger(): any {
        return this.host?.logger ?? this.ownLogger;
    }

    private get maxAttendees(): number {
        return this.host?.maxAttendees ?? this.ownMaxAttendees;
    }

    /** `event`'s organizer as one of its mailbox's own addresses, or `undefined` when the event isn't the organizer's own copy. Cached in `cache`
     * per mailbox. */
    public async organizerIdentity(
        event: Pick<CalendarEvent, "organizer" | "mailboxUid">,
        cache: Map<string, MailboxIdentity> = new Map(),
    ): Promise<MailboxIdentity | undefined> {
        const organizerAddress: string = (event.organizer?.address ?? "").trim().toLowerCase();
        if (!organizerAddress || !event.mailboxUid) {
            return undefined;
        }
        let identity: MailboxIdentity | undefined = cache.get(event.mailboxUid);
        if (!identity) {
            const mailbox: any = await this.mailboxRepo?.findOne(event.mailboxUid, { ignoreACL: true });
            identity = {
                addresses: new Set(
                    (mailbox ? [mailbox.primarySmtpAddress, ...(mailbox.aliasAddresses ?? [])] : [])
                        .filter((address: unknown) => typeof address === "string")
                        .map((address: string) => address.trim().toLowerCase()),
                ),
                displayName: safeDisplayName(mailbox?.displayName),
            };
            cache.set(event.mailboxUid, identity);
        }
        return identity.addresses.has(organizerAddress) ? identity : undefined;
    }

    /**
     * Mails the event's iTIP `method` to every mailable attendee except the organizer (see this class's doc comment): one
     * message, composed as the organizer's mailbox identity and scanned once by `scanAndRelay()`, relayed to each
     * attendee on its own envelope. A failure for one attendee is logged and the rest still go out (see this class's doc
     * comment for why the row stays claimed); a refused scan, or no attendee accepting it, throws.
     *
     * The exceptions are a `REQUEST` for an event carrying a `videoMeetingUid`, and any `REQUEST`/`CANCEL` for an event whose guests
     * can't see the guest list, which are handed to `sendPerAttendee()` instead - see its own doc comment. Everything above it here (the plain-address filter,
     * the deduplication that also excludes the organizer's own address, the attendee cap, the "nobody left to mail"
     * early return) is shared by both paths and deliberately identical for them.
     */
    /**
     * Whether `event`'s video meeting is protected by a per-meeting key: one of its attendee links is `keyed`, so its invitations need the
     * keys only a save supplies (`sendProtectedInvitations()`).
     */
    public async isKeyedMeeting(event: CalendarEvent): Promise<boolean> {
        if (!event.videoMeetingUid || !this.attendeeLinkRepo) {
            return false;
        }
        return (await this.attendeeLinkRepo.count({ calendarEventUid: ModelUtils.literal(event.uid), keyed: true } as any, { ignoreACL: true })) > 0;
    }

    public async sendToAttendees(event: CalendarEvent, organizer: MailboxIdentity, method: "request" | "cancel", secrets?: MeetingLinkSecrets): Promise<void> {
        const what: string = method === "cancel" ? "cancellation" : "invite";
        const seen: Set<string> = new Set([normalizeAddress(event.organizer.address)]);
        const recipients: string[] = [];
        const listed: Attendee[] = [];
        for (const attendee of event.attendees) {
            if (!attendee?.address) {
                continue;
            }
            if (!isPlainAddress(attendee.address)) {
                this.logger?.warn(`MeetingSchedulingJob: skipping an attendee of event ${event.uid} that isn't a plain address: ${JSON.stringify(String(attendee.address).slice(0, 100))}`);
                continue;
            }
            listed.push({ ...attendee, displayName: safeDisplayName(attendee.displayName) });
            const normalized: string = normalizeAddress(attendee.address);
            if (!seen.has(normalized)) {
                seen.add(normalized);
                recipients.push(attendee.address);
            }
        }
        if (recipients.length === 0) {
            return;
        }
        if (recipients.length > Number(this.maxAttendees)) {
            this.logger?.error(
                `MeetingSchedulingJob: not sending the ${what} for event ${event.uid} - it has ${recipients.length} attendees, more than the ${this.maxAttendees} allowed.`,
            );
            return;
        }

        // The only branches on the way to a send, and the only ones an event with no linked video meeting and a
        // visible guest list ever evaluates: plain field reads of a row already in memory, no query. Everything below
        // them - the whole compose-once, fan-out-by-envelope path - is untouched for such an event.
        const hiddenGuestList: boolean = !guestPermissionsOf(event).guestsCanSeeGuestList;
        if ((method === "request" && event.videoMeetingUid) || hiddenGuestList) {
            await this.sendPerAttendee(event, organizer, listed, recipients, method, what, hiddenGuestList, secrets);
            return;
        }

        const mailed: CalendarEvent = { ...event, organizer: { ...event.organizer, displayName: organizer.displayName }, attendees: listed };
        const ics: string = buildEventIcs(mailed, method === "cancel" ? "CANCEL" : "REQUEST");
        const composed: Buffer = await new MailComposer({
            from: organizer.displayName ? { name: organizer.displayName, address: event.organizer.address } : event.organizer.address,
            to: recipients,
            subject: method === "cancel" ? `Cancelled: ${event.title}` : `Invitation: ${event.title}`,
            text: method === "cancel" ? `This meeting has been cancelled: ${event.title}` : `You have been invited to: ${event.title}${this.descriptionNote(event)}`,
            icalEvent: { method, content: ics },
        })
            .compile()
            .build();

        // One relay per attendee, each through `sendOrThrow()`; `scanAndRelay()` sees the whole fan-out as one send.
        const fanOut = {
            send: async (outbound: OutboundMessage): Promise<TransportResult> => {
                const result: TransportResult = { accepted: [], rejected: [] };
                for (const to of outbound.envelopeTo) {
                    try {
                        await sendOrThrow(this.mailTransport!, { ...outbound, envelopeTo: [to] });
                        result.accepted.push(to);
                    } catch (err: any) {
                        result.rejected.push(to);
                        this.logger?.warn(`MeetingSchedulingJob: failed to send ${what} for event ${event.uid} to ${to}: ${err.message}`);
                    }
                }
                return result;
            },
        };
        await scanAndRelay(composed, event.organizer.address, recipients, this.scanPipeline!, fanOut, this.blobStore!);
    }

    /**
     * Sends the invitations for an event of a calendar zero-access encryption protects, as it was just saved, from the plaintext `content`
     * of the request that saved it (`specs/search.md` §3 *What It Covers*, *Calendar invitations*): the stored title is sealed, so
     * `MeetingSchedulingJob`, which composes invitations from stored events, can't and doesn't. The job's rules apply - only the organizer's
     * own copy, with attendees, not cancelled, whose current `sequence` hasn't been sent (`invitationsPending()`) - and the revision is
     * claimed with a versioned update of `eventRepo` first, so it is sent once. A meeting protected by a per-meeting key
     * (`isKeyedMeeting()`, meet-plugin `specs/meeting_privacy.md` §4.1) is sent the same way, whether or not its event is sealed: each
     * guest's keyed link gets that guest's key from `secrets`, which is never stored. Without the `content` a sealed event needs, or the
     * `secrets` a keyed meeting needs, nothing is sent and the invitation stays pending until a save that has them. An event the organizer
     * sends encrypted itself (`encryptionOrigin` `"originated"`) is claimed and never sent, as `MeetingSchedulingJob` does. Never throws: a
     * failure is logged, as `source`.
     *
     * Returns the row the claim wrote - a new `version` - or `undefined` when nothing was claimed: a caller holding `event` replaces it,
     * so the version it hands back (a route's response, a notification) is the stored one.
     */
    public async sendProtectedInvitations(
        event: CalendarEvent,
        content: InvitationContent | undefined,
        eventRepo: RepoUtils<any>,
        source: string,
        secrets?: MeetingLinkSecrets,
    ): Promise<CalendarEvent | undefined> {
        if (!invitationsPending(event)) {
            return undefined;
        }
        const sealed: boolean = isSealedEvent(event);
        const keyed: boolean = await this.isKeyedMeeting(event);
        if (!sealed && !keyed) {
            return undefined;
        }
        const originated: boolean = event.encryptionOrigin === "originated";
        if (!originated && ((sealed && !content) || (keyed && !secrets))) {
            this.logger?.warn(`${source}: not sending the invitations for protected event ${event.uid}: the request carried no ${sealed && !content ? "invitation content" : "meeting link keys"}.`);
            return undefined;
        }
        let claimed: CalendarEvent | undefined;
        try {
            const organizer: MailboxIdentity | undefined = await this.organizerIdentity(event);
            if (!organizer) {
                return undefined;
            }
            claimed = await eventRepo.update({ uid: event.uid, version: (event as any).version, inviteSequenceSent: event.sequence } as any, event as any, { ignoreACL: true });
            if (!originated) {
                await this.sendToAttendees(content ? { ...event, ...content } : event, organizer, "request", secrets);
            }
        } catch (err: any) {
            this.logger?.warn(`${source}: failed to send the invitations for protected event ${event.uid}: ${err?.message ?? err}`);
        }
        return claimed;
    }

    /** The event's plain-text description as a paragraph to add to an invitation's body, or `""` when it has none. */
    private descriptionNote(event: CalendarEvent): string {
        return event.description ? `\n\n${event.description}` : "";
    }

    /**
     * Mails an event's `method` (`REQUEST` or `CANCEL`) as one message composed, scanned and relayed *per attendee*, for the
     * two events that can't share one message between everybody:
     *
     * - **A `REQUEST` for an event with a linked video meeting**: each attendee's copy carries that attendee's own
     * personalized link - a keyed one with the attendee's key, and not at all to an attendee whose copy would be stored on this server
     * readable (`host.mayCarryMeetingKey`) - (their own `LOCATION`, and a line naming it in the body) from this event's `CalendarEventAttendeeLink`
     * rows - see this class's doc comment for why that lookup is generic and knows nothing of whichever plugin wrote those rows.
     * Every fallback here is graceful and per-attendee: a lookup that fails outright, one that returns nothing, and one that
     * returns rows for only some attendees all end in the same place - an attendee with no matching row gets the event's own
     * plain stored `location` and today's plain invite text, exactly what the shared path would have mailed them.
     * - **An event whose guests can't see the guest list** (`CalendarEvent.guestsCanSeeGuestList` `false`; `hiddenGuestList`), a
     * `REQUEST` *and* a `CANCEL`: each attendee's copy lists only that attendee (and the organizer's own attendee entry, if the
     * event has one - the `ORGANIZER` line names the organizer regardless), so the copy that lands in their calendar never holds
     * anyone else. The organizer's own row still lists everyone.
     *
     * `recipients` is the shared, already-deduplicated recipient list, which never contains the organizer's own address; a stray
     * `CalendarEventAttendeeLink` row for the organizer therefore cannot cause a message to them, since this only ever mails
     * addresses that list already holds.
     */
    private async sendPerAttendee(
        event: CalendarEvent,
        organizer: MailboxIdentity,
        listed: Attendee[],
        recipients: string[],
        method: "request" | "cancel",
        what: string,
        hiddenGuestList: boolean,
        secrets?: MeetingLinkSecrets,
    ): Promise<void> {
        const links: Map<string, { url: string; label?: string; keyed?: boolean | null }> = new Map();
        try {
            if (method === "request" && event.videoMeetingUid) {
                // Bounded by the same cap the attendee list itself is bounded by - there can be no more useful rows
                // than there are attendees this job is willing to mail.
                const rows: CalendarEventAttendeeLink[] = await this.attendeeLinkRepo!.find(
                    { calendarEventUid: ModelUtils.literal(event.uid), limit: Number(this.maxAttendees) } as any,
                    { ignoreACL: true, limit: Number(this.maxAttendees) },
                );
                for (const row of rows) {
                    links.set(normalizeAddress(row.attendeeAddress), { url: row.url, label: row.label, keyed: row.keyed });
                }
            }
        } catch (err: any) {
            // Never abort the send over this: an empty map means every attendee falls back to the event's own
            // stored location, which is exactly what would have been mailed before personalization existed.
            this.logger?.warn(`MeetingSchedulingJob: failed to read personalized attendee links for event ${event.uid}: ${err.message}`);
        }
        const organizerAddress: string = normalizeAddress(event.organizer.address);

        // Each attendee's own relay, through `sendOrThrow()` exactly like the shared path's fan-out - a transport
        // that reports its one recipient as rejected still counts as a failure.
        const relay = {
            name: this.mailTransport!.name,
            send: async (outbound: OutboundMessage): Promise<TransportResult> => await sendOrThrow(this.mailTransport!, outbound),
        };
        // Identical for every copy - only the location and the body's link line differ per attendee.
        const from = organizer.displayName ? { name: organizer.displayName, address: event.organizer.address } : event.organizer.address;
        for (const to of recipients) {
            try {
                const attendee: string = normalizeAddress(to);
                const stored: { url: string; label?: string; keyed?: boolean | null } | undefined = links.get(attendee);
                // A keyed link opens its meeting only with the attendee's key, which is added here and never stored; without it the
                // attendee isn't sent a link that can't work.
                if (stored?.keyed && !secrets?.[attendee]) {
                    this.logger?.warn(`MeetingSchedulingJob: not sending the ${what} for event ${event.uid} to ${to}: no key for their meeting link.`);
                    continue;
                }
                // The key must never be stored here, so it doesn't go to a mailbox of this server whose copy would be filed readable - nor
                // to anybody from a sender that can't tell (no `mayCarryMeetingKey`).
                if (stored?.keyed && !(await this.host?.mayCarryMeetingKey?.(attendee))) {
                    this.logger?.warn(
                        `MeetingSchedulingJob: not sending the ${what} for event ${event.uid} to ${to}: their copy would be stored here readable, with their meeting link's key.`,
                    );
                    continue;
                }
                const link: { url: string; label?: string } | undefined = stored && { ...stored, url: stored.keyed ? `${stored.url}#${secrets![attendee]}` : stored.url };
                const mailed: CalendarEvent = {
                    ...event,
                    organizer: { ...event.organizer, displayName: organizer.displayName },
                    attendees: hiddenGuestList
                        ? listed.filter((entry) => normalizeAddress(entry.address) === attendee || normalizeAddress(entry.address) === organizerAddress)
                        : listed,
                    location: link ? link.url : event.location,
                };
                const ics: string = buildEventIcs(mailed, method === "cancel" ? "CANCEL" : "REQUEST");
                const composed: Buffer = await new MailComposer({
                    from,
                    to: [to],
                    subject: method === "cancel" ? `Cancelled: ${event.title}` : `Invitation: ${event.title}`,
                    text:
                        method === "cancel"
                            ? `This meeting has been cancelled: ${event.title}`
                            : link
                              ? `You have been invited to: ${event.title}\n\nJoin the video call: ${link.url}${this.descriptionNote(event)}`
                              : `You have been invited to: ${event.title}${this.descriptionNote(event)}`,
                    icalEvent: { method, content: ics },
                })
                    .compile()
                    .build();
                await scanAndRelay(composed, event.organizer.address, [to], this.scanPipeline!, relay, this.blobStore!);
            } catch (err: any) {
                this.logger?.warn(`MeetingSchedulingJob: failed to send ${what} for event ${event.uid} to ${to}: ${err.message}`);
            }
        }
    }
}
