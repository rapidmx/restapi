///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// THE mailbox-access matrix. No role - a trusted/admin one included - grants access to another user's personal mail
// data: only the mailbox's owner and holders of an explicit ACL grant get in, and an administrator sees another user's
// account only by impersonating them. This suite calls one representative endpoint of EVERY mailbox-scoped route class as
//
//   (a) the owner                          (d) an unrelated normal user
//   (b) a delegate with a read-only ACL    (e) a trusted + elevated administrator who is neither owner nor delegate
//   (c) a delegate with a write ACL        (g) an impersonation token (the owner's uid, no trusted role, not elevated)
//
// and asserts that only (a), (b), (c), (g) get in - each as far as its rights go - while (d) and (e) get a 403/404/empty
// answer (never an answer that carries the mailbox's data) and, for a write, change nothing. `MATRIX_CASES` is the ONE
// table both this suite and `mailAccessGuard.test.ts` read: the guard fails when a mailbox-scoped route class isn't in it,
// so a new route can't ship without being put through the matrix. (f), the administrator's `?scope=admin` metadata call,
// has its own tests at the end.
//
// Run on both backends by `test/routes/{mongo,sql}/MailAccessMatrix.test.ts`.
import { request } from "@rapidrest/service-core/test";
import * as uuid from "uuid";
import { FolderType, MessageImportance, QuarantineReason, RecipientType } from "../../src/models/types.js";
import type { InMemoryBlobStore } from "../testDoubles.js";
import type { EntityStore } from "./entityStore.js";

export interface MailAccessMatrixContext {
    app: () => any;
    /** `"/mongo"` or `"/sql"`. */
    prefix: string;
    token: (user: any) => string;
    store: () => EntityStore;
    blobStore: () => InMemoryBlobStore;
    findAcl: (uid: string) => Promise<any | undefined>;
}

/** Everything one test seeds: a mailbox owned by `owner` with a read-only and a write delegate, its folders and one record
 * of each kind, all carrying `marker`. */
export interface MatrixSeed {
    /** This seed's own people: fresh uids per seed, so "the caller's own mailbox" is unambiguous. */
    personas: Record<Persona, any>;
    /** A user nobody in the seed is, known to the server (owns a mailbox of their own) - what a grant can name. */
    grantee: string;
    marker: string;
    mailbox: any;
    folders: Record<"inbox" | "drafts" | "calendar" | "contacts" | "tasks" | "user", any>;
    message: any;
    attachment: any;
    /** One row per scoped-child kind, keyed by the case's `kind`. */
    rows: Record<string, any>;
}

export type Persona = "owner" | "reader" | "writer" | "stranger" | "admin" | "impersonated";

export interface MatrixRequest {
    method: "get" | "head" | "post" | "put" | "delete";
    path: string;
    body?: any;
    /** A raw body, sent with this content type (mailbox imports). */
    raw?: { type: string; data: Buffer };
}

export interface MatrixCase {
    /** The route class (`XRoute`, no backend suffix) this case exercises - what `mailAccessGuard.test.ts` checks against. */
    route: string;
    name: string;
    /** `read` cases are open to a read-only delegate; `write` cases only to the owner and a write delegate. */
    access: "read" | "write";
    request: (s: MatrixSeed, prefix: string) => MatrixRequest;
    /** Whether `res` is the success this case asks for (a real read of the seeded data, a real change). */
    success: (res: any, s: MatrixSeed) => boolean;
    /** Only these personas get in (default: everyone the `access` allows). */
    only?: Persona[];
    /** The administrator's call is answered (200) but changes nothing and shows nothing of the mailbox: a write to a mailbox row
     * an administrator manages, of which only the administrative fields take effect. */
    adminNoOp?: boolean;
    /** The one thing an administrator (trusted + elevated) may do to a mailbox they hold no grant on, without seeing any mail: the
     * audited Sharing action of the admin console. The administrator is let in, and this audit entry must result. */
    adminAudited?: string;
    /** Whether the write happened - checked (negatively) after a denied call. */
    changed?: (s: MatrixSeed, store: EntityStore, findAcl: (uid: string) => Promise<any>) => Promise<boolean>;
}

/** Every route class name the matrix exercises (see `mailAccessGuard.test.ts`). */
export function matrixRouteClasses(): Set<string> {
    return new Set(MATRIX_CASES.map((c) => c.route));
}

const READ_ACTIONS: string[] = ["read", "list", "count", "exists"];
const WRITE_ACTIONS: string[] = [...READ_ACTIONS, "create", "update", "delete"];

const ok = (res: any): boolean => res.status >= 200 && res.status < 300;
const hasUid = (res: any, uid: string): boolean => ok(res) && Array.isArray(res.body) && res.body.some((row: any) => row.uid === uid);
const gotRow = (res: any, uid: string): boolean => ok(res) && res.body?.uid === uid;
const list = (path: string, query: string): MatrixRequest => ({ method: "get", path: `${path}?${query}` });

/** A folder-scoped or mailbox-scoped kind served by `BaseScopedChildRoute`: the same five calls on each. */
interface ScopedKind {
    route: string;
    kind: string;
    path: string;
    scope: "folderUid" | "mailboxUid";
    folder?: keyof MatrixSeed["folders"];
    /** The stored row's fields beyond its scope; `marker` goes in a text field. */
    fields: (s: MatrixSeed) => Record<string, any>;
    /** The body of a create (beyond the scope fields the matrix adds). */
    create: (s: MatrixSeed) => Record<string, any>;
    /** A patch that changes the row. */
    patch: Record<string, any>;
    changedField: string;
}

const SCOPED_KINDS: ScopedKind[] = [
    {
        route: "ContactRoute",
        kind: "Contact",
        path: "/contacts",
        scope: "folderUid",
        folder: "contacts",
        fields: (s) => ({ displayName: s.marker, emails: [{ address: `${uuid.v4()}@example.net` }], phones: [], addresses: [] }),
        create: () => ({ displayName: "New contact", emails: [], phones: [], addresses: [] }),
        patch: { displayName: "Changed" },
        changedField: "displayName",
    },
    {
        route: "CalendarEventRoute",
        kind: "CalendarEvent",
        path: "/calendar-events",
        scope: "folderUid",
        folder: "calendar",
        fields: (s) => ({
            title: s.marker,
            startDate: new Date("2030-01-01T10:00:00Z"),
            endDate: new Date("2030-01-01T11:00:00Z"),
            allDay: false,
            timezone: "UTC",
            organizer: { address: "owner@example.com", type: RecipientType.TO },
            attendees: [],
            icalUid: `${uuid.v4()}@example.com`,
        }),
        create: () => ({
            title: "New event",
            startDate: "2030-02-01T10:00:00Z",
            endDate: "2030-02-01T11:00:00Z",
            allDay: false,
            timezone: "UTC",
            organizer: { address: "owner@example.com", type: RecipientType.TO },
            attendees: [],
        }),
        patch: { title: "Changed" },
        changedField: "title",
    },
    {
        route: "TaskRoute",
        kind: "Task",
        path: "/tasks",
        scope: "folderUid",
        folder: "tasks",
        fields: (s) => ({ title: s.marker, completed: false }),
        create: () => ({ title: "New task", completed: false }),
        patch: { title: "Changed" },
        changedField: "title",
    },
    {
        route: "NoteRoute",
        kind: "Note",
        path: "/notes",
        scope: "folderUid",
        folder: "user",
        fields: (s) => ({ title: s.marker, body: `body ${s.marker}` }),
        create: () => ({ title: "New note", body: "text" }),
        patch: { title: "Changed" },
        changedField: "title",
    },
    {
        route: "TaskListRoute",
        kind: "TaskList",
        path: "/task-lists",
        scope: "mailboxUid",
        fields: (s) => ({ name: s.marker }),
        create: () => ({ name: "New list" }),
        patch: { name: "Changed" },
        changedField: "name",
    },
    {
        route: "ContactListRoute",
        kind: "ContactList",
        path: "/contact-lists",
        scope: "mailboxUid",
        fields: (s) => ({ name: s.marker }),
        create: () => ({ name: "New list" }),
        patch: { name: "Changed" },
        changedField: "name",
    },
    {
        route: "LabelRoute",
        kind: "Label",
        path: "/labels",
        scope: "mailboxUid",
        fields: (s) => ({ name: s.marker }),
        create: () => ({ name: "New label" }),
        patch: { name: "Changed" },
        changedField: "name",
    },
    {
        route: "MailSignatureRoute",
        kind: "MailSignature",
        path: "/mail-signatures",
        scope: "mailboxUid",
        fields: (s) => ({ name: s.marker, contentHtml: `<p>${s.marker}</p>`, isDefaultForNewMessages: false, isDefaultForReplyForward: false }),
        create: () => ({ name: "New signature", contentHtml: "<p>hi</p>", isDefaultForNewMessages: false, isDefaultForReplyForward: false }),
        patch: { name: "Changed" },
        changedField: "name",
    },
    {
        route: "MailFilterRuleRoute",
        kind: "MailFilterRule",
        path: "/mail-filter-rules",
        scope: "mailboxUid",
        fields: (s) => ({ name: s.marker, enabled: true, sequence: 1, stopProcessingRules: false, conditions: { fromContains: [s.marker] }, actions: [] }),
        create: () => ({ name: "New rule", enabled: true, sequence: 2, stopProcessingRules: false, conditions: { fromContains: ["x"] }, actions: [] }),
        patch: { name: "Changed" },
        changedField: "name",
    },
    {
        route: "FocusedInboxOverrideRoute",
        kind: "FocusedInboxOverride",
        path: "/focused-inbox-overrides",
        scope: "mailboxUid",
        fields: (s) => ({ senderAddress: `${s.marker}@example.net`, classifyAs: "focused" }),
        create: () => ({ senderAddress: `${uuid.v4()}@example.net`, classifyAs: "other" }),
        patch: { classifyAs: "other" },
        changedField: "classifyAs",
    },
];

/** The scope query/body value of `kind` in `s`. */
function scopeUid(kind: ScopedKind, s: MatrixSeed): string {
    return kind.scope === "mailboxUid" ? s.mailbox.uid : s.folders[kind.folder!].uid;
}

function scopedCases(kind: ScopedKind): MatrixCase[] {
    const row = (s: MatrixSeed): any => s.rows[kind.kind];
    return [
        {
            route: kind.route,
            name: `${kind.kind}: list by ${kind.scope}`,
            access: "read",
            request: (s) => list(kind.path, `${kind.scope}=${scopeUid(kind, s)}`),
            success: (res, s) => hasUid(res, row(s).uid),
        },
        {
            route: kind.route,
            name: `${kind.kind}: get by uid`,
            access: "read",
            request: (s) => ({ method: "get", path: `${kind.path}/${row(s).uid}` }),
            success: (res, s) => gotRow(res, row(s).uid),
        },
        {
            route: kind.route,
            name: `${kind.kind}: count`,
            access: "read",
            request: (s) => ({ method: "head", path: `${kind.path}?${kind.scope}=${scopeUid(kind, s)}` }),
            success: (res) => ok(res) && Number(res.headers["content-length"]) >= 1,
        },
        {
            route: kind.route,
            name: `${kind.kind}: create`,
            access: "write",
            request: (s) => ({ method: "post", path: kind.path, body: { ...kind.create(s), [kind.scope]: scopeUid(kind, s), mailboxUid: s.mailbox.uid } }),
            success: (res) => ok(res),
            changed: async (s, store) => (await store.find(kind.kind, { [kind.scope]: scopeUid(kind, s) })).length > 1,
        },
        {
            route: kind.route,
            name: `${kind.kind}: update`,
            access: "write",
            request: (s) => ({ method: "put", path: `${kind.path}/${row(s).uid}`, body: { uid: row(s).uid, version: row(s).version, ...kind.patch } }),
            success: (res) => ok(res),
            changed: async (s, store) => (await store.find(kind.kind, { uid: row(s).uid }))[0]?.[kind.changedField] !== row(s)[kind.changedField],
        },
        {
            route: kind.route,
            name: `${kind.kind}: delete`,
            access: "write",
            request: (s) => ({ method: "delete", path: `${kind.path}/${row(s).uid}?purge=true` }),
            success: (res) => ok(res),
            changed: async (s, store) => (await store.find(kind.kind, { uid: row(s).uid })).length === 0,
        },
    ];
}

export const MATRIX_CASES: MatrixCase[] = [
    // MailboxRoute
    {
        route: "MailboxRoute",
        name: "Mailbox: list",
        access: "read",
        request: (_s, _p) => ({ method: "get", path: "/mailboxes" }),
        success: (res, s) => hasUid(res, s.mailbox.uid),
    },
    {
        route: "MailboxRoute",
        name: "Mailbox: get by uid",
        access: "read",
        request: (s) => ({ method: "get", path: `/mailboxes/${s.mailbox.uid}` }),
        success: (res, s) => gotRow(res, s.mailbox.uid),
    },
    {
        route: "MailboxRoute",
        name: "Mailbox: count",
        access: "read",
        request: () => ({ method: "head", path: "/mailboxes" }),
        success: (res) => ok(res) && Number(res.headers["content-length"]) >= 1,
    },
    {
        route: "MailboxRoute",
        name: "Mailbox: update its settings (the out-of-office text)",
        access: "write",
        request: (s) => ({ method: "put", path: `/mailboxes/${s.mailbox.uid}`, body: { uid: s.mailbox.uid, version: s.mailbox.version, oofMessage: "Away" } }),
        adminNoOp: true,
        success: (res) => ok(res),
        changed: async (s, store) => (await store.find("Mailbox", { uid: s.mailbox.uid }))[0]?.oofMessage !== s.mailbox.oofMessage,
    },
    // FolderRoute
    {
        route: "FolderRoute",
        name: "Folder: list by mailboxUid",
        access: "read",
        request: (s) => list("/folders", `mailboxUid=${s.mailbox.uid}`),
        success: (res, s) => hasUid(res, s.folders.inbox.uid),
    },
    {
        route: "FolderRoute",
        name: "Folder: get by uid",
        access: "read",
        request: (s) => ({ method: "get", path: `/folders/${s.folders.inbox.uid}` }),
        success: (res, s) => gotRow(res, s.folders.inbox.uid),
    },
    {
        route: "FolderRoute",
        name: "Folder: create",
        access: "write",
        request: (s) => ({ method: "post", path: "/folders", body: { mailboxUid: s.mailbox.uid, name: "New folder", type: FolderType.USER } }),
        success: (res) => ok(res),
        changed: async (s, store) => (await store.find("Folder", { mailboxUid: s.mailbox.uid })).length > 6,
    },
    {
        route: "FolderRoute",
        name: "Folder: rename",
        access: "write",
        request: (s) => ({ method: "put", path: `/folders/${s.folders.user.uid}`, body: { uid: s.folders.user.uid, version: s.folders.user.version, name: "Renamed" } }),
        success: (res) => ok(res),
        changed: async (s, store) => (await store.find("Folder", { uid: s.folders.user.uid }))[0]?.name !== s.folders.user.name,
    },
    {
        route: "FolderRoute",
        name: "Folder: delete all of a mailbox's folders (truncate)",
        access: "write",
        // Truncating needs the `truncate` action, which the write delegate's grant doesn't carry.
        only: ["owner", "impersonated"],
        request: (s) => ({ method: "delete", path: `/folders?mailboxUid=${s.mailbox.uid}` }),
        success: (res) => ok(res),
        changed: async (s, store) => (await store.find("Folder", { mailboxUid: s.mailbox.uid })).length === 0,
    },
    {
        route: "FolderRoute",
        name: "Folder: delete",
        access: "write",
        request: (s) => ({ method: "delete", path: `/folders/${s.folders.user.uid}?purge=true` }),
        success: (res) => ok(res),
        changed: async (s, store) => (await store.find("Folder", { uid: s.folders.user.uid })).length === 0,
    },
    // MessageRoute
    {
        route: "MessageRoute",
        name: "Message: list by folderUid",
        access: "read",
        request: (s) => list("/messages", `folderUid=${s.folders.inbox.uid}`),
        success: (res, s) => hasUid(res, s.message.uid),
    },
    {
        route: "MessageRoute",
        name: "Message: get by uid",
        access: "read",
        request: (s) => ({ method: "get", path: `/messages/${s.message.uid}` }),
        success: (res, s) => gotRow(res, s.message.uid),
    },
    {
        route: "MessageRoute",
        name: "Message: sanitized content",
        access: "read",
        request: (s) => ({ method: "get", path: `/messages/${s.message.uid}/content` }),
        success: (res, s) => ok(res) && String(res.text ?? res.body).includes(s.marker),
    },
    {
        route: "MessageRoute",
        name: "Message: conversations by mailboxUid",
        access: "read",
        request: (s) => list("/messages/conversations", `mailboxUid=${s.mailbox.uid}`),
        success: (res) => ok(res) && Array.isArray(res.body) && res.body.length >= 1,
    },
    {
        route: "MessageRoute",
        name: "Message: count",
        access: "read",
        request: (s) => ({ method: "head", path: `/messages?folderUid=${s.folders.inbox.uid}` }),
        success: (res) => ok(res) && Number(res.headers["content-length"]) >= 1,
    },
    {
        route: "MessageRoute",
        name: "Message: update (mark read)",
        access: "write",
        request: (s) => ({ method: "put", path: `/messages/${s.message.uid}`, body: { uid: s.message.uid, version: s.message.version, flags: { read: true, flagged: false, answered: false, forwarded: false } } }),
        success: (res) => ok(res),
        changed: async (s, store) => (await store.find("Message", { uid: s.message.uid }))[0]?.flags?.read === true,
    },
    {
        route: "MessageRoute",
        name: "Message: archive",
        access: "write",
        request: (s) => ({ method: "post", path: `/messages/${s.message.uid}/archive` }),
        success: (res) => ok(res),
        changed: async (s, store) => (await store.find("Message", { uid: s.message.uid }))[0]?.folderUid !== s.message.folderUid,
    },
    {
        route: "MessageRoute",
        name: "Message: delete",
        access: "write",
        request: (s) => ({ method: "delete", path: `/messages/${s.message.uid}?purge=true` }),
        success: (res) => ok(res),
        changed: async (s, store) => (await store.find("Message", { uid: s.message.uid })).length === 0,
    },
    // AttachmentRoute
    {
        route: "AttachmentRoute",
        name: "Attachment: list by messageUid",
        access: "read",
        request: (s) => list("/attachments", `messageUid=${s.message.uid}`),
        success: (res, s) => hasUid(res, s.attachment.uid),
    },
    {
        route: "AttachmentRoute",
        name: "Attachment: get by uid",
        access: "read",
        request: (s) => ({ method: "get", path: `/attachments/${s.attachment.uid}` }),
        success: (res, s) => gotRow(res, s.attachment.uid),
    },
    {
        route: "AttachmentRoute",
        name: "Attachment: download",
        access: "read",
        request: (s) => ({ method: "get", path: `/attachments/${s.attachment.uid}/content` }),
        success: (res, s) => ok(res) && String(res.text ?? res.body).includes(s.marker),
    },
    {
        route: "AttachmentRoute",
        name: "Attachment: delete",
        access: "write",
        request: (s) => ({ method: "delete", path: `/attachments/${s.attachment.uid}` }),
        success: (res) => ok(res),
        changed: async (s, store) => (await store.find("Attachment", { uid: s.attachment.uid })).every((a: any) => a.deleted === true) === true,
    },
    // scoped children (Contact, CalendarEvent, Task, Note, TaskList, ContactList, Label, MailSignature, MailFilterRule, FocusedInboxOverride)
    ...SCOPED_KINDS.flatMap(scopedCases),
    // CalendarShareLinkRoute
    {
        route: "CalendarShareLinkRoute",
        name: "CalendarShareLink: list by folderUid",
        access: "read",
        request: (s) => list("/calendar-share-links", `folderUid=${s.folders.calendar.uid}`),
        success: (res, s) => hasUid(res, s.rows.CalendarShareLink.uid),
    },
    {
        route: "CalendarShareLinkRoute",
        name: "CalendarShareLink: create",
        access: "write",
        request: (s) => ({ method: "post", path: "/calendar-share-links", body: { folderUid: s.folders.calendar.uid, permittedActions: ["read"] } }),
        success: (res) => ok(res),
        changed: async (s, store) => (await store.find("CalendarShareLink", { folderUid: s.folders.calendar.uid })).length > 1,
    },
    // QuarantineRoute and IngestQueueRoute (also reachable with `?scope=admin` - see the admin tests below)
    {
        route: "QuarantineRoute",
        name: "QuarantineEntry: list by mailboxUid",
        access: "read",
        request: (s) => list("/quarantine", `mailboxUid=${s.mailbox.uid}`),
        success: (res, s) => hasUid(res, s.rows.QuarantineEntry.uid),
    },
    {
        route: "IngestQueueRoute",
        name: "IngestQueueEntry: list by mailboxUid",
        access: "read",
        request: (s) => list("/ingest-queue", `mailboxUid=${s.mailbox.uid}`),
        success: (res, s) => hasUid(res, s.rows.IngestQueueEntry.uid),
    },
    // MailboxAccessRoute (sharing)
    {
        route: "MailboxAccessRoute",
        name: "Sharing: list members",
        access: "write",
        adminAudited: "mailbox_access.admin-list",
        request: (s) => ({ method: "get", path: `/mailboxes/${s.mailbox.uid}/access` }),
        success: (res) => ok(res) && Array.isArray(res.body),
    },
    {
        route: "MailboxAccessRoute",
        name: "Sharing: grant a member",
        access: "write",
        request: (s) => ({ method: "put", path: `/mailboxes/${s.mailbox.uid}/access/${s.grantee}`, body: { role: "viewer" } }),
        success: (res) => ok(res),
        changed: async (s, _store, findAcl) => ((await findAcl(s.mailbox.uid))?.records?.length ?? 0) > 3,
    },
    // KeyVaultRoute, KeyLookupRoute
    {
        route: "KeyVaultRoute",
        name: "KeyVault: read",
        access: "read",
        request: (s) => ({ method: "get", path: `/mailboxes/${s.mailbox.uid}/keyvault` }),
        success: (res) => ok(res),
    },
    {
        route: "KeyLookupRoute",
        name: "KeyLookup: lookup an address",
        access: "write",
        request: (s) => ({ method: "get", path: `/mailboxes/${s.mailbox.uid}/keys/lookup?addr=someone@example.net` }),
        // Let in: the lookup ran (and found no keys for an address nobody has published one for).
        success: (res) => ok(res) || (res.status === 404 && res.body?.code === "api-010"),
    },
    // SearchRoute
    {
        route: "SearchRoute",
        name: "Search: query a mailbox",
        access: "read",
        request: (s) => ({ method: "get", path: `/search?mailboxUid=${s.mailbox.uid}&q=hello` }),
        success: (res) => ok(res),
    },
    // DirectoryRoute (the mailbox's own contacts as recipient suggestions)
    {
        route: "DirectoryRoute",
        name: "Directory: contact suggestions from a mailbox",
        access: "read",
        request: (s) => ({ method: "get", path: `/directory/contacts?mailboxUid=${s.mailbox.uid}&q=secret` }),
        success: (res) => ok(res) && Array.isArray(res.body) && res.body.length >= 1,
    },
    // MailboxImportRequestRoute
    {
        route: "MailboxImportRequestRoute",
        name: "Import: start an mbox import into a mailbox",
        access: "write",
        // A delegate imports into their own mailbox only; an administrator by impersonating the owner (which is the owner).
        only: ["owner", "impersonated"],
        request: (s) => ({
            method: "post",
            path: `/mailbox-import-requests?format=mbox&targetFolderUid=${s.folders.inbox.uid}&mailboxUid=${s.mailbox.uid}`,
            raw: { type: "application/mbox", data: Buffer.from("From a@b.c Mon Jan  1 00:00:00 2030\nSubject: x\n\nbody\n") },
        }),
        success: (res) => ok(res),
        changed: async (s, store) => (await store.find("MailboxImportRequest", { mailboxUid: s.mailbox.uid })).length > 0,
    },
];

export function mailAccessMatrixSuite(ctx: MailAccessMatrixContext): void {
    const user = (roles: string[] = []): any => ({ uid: uuid.v4(), roles, scopes: [], elevated: Date.now() });
    const newPersonas = (): Record<Persona, any> => {
        const owner = user();
        return {
            owner,
            reader: user(),
            writer: user(),
            stranger: user(),
            admin: user(["admin"]),
            // What `POST /impersonate` mints: the target's own identity, its own (here no) roles, not elevated.
            impersonated: { uid: owner.uid, roles: [], scopes: [], elevated: -1 },
        };
    };
    const PERSONAS: Persona[] = ["owner", "reader", "writer", "stranger", "admin", "impersonated"];
    const allowed = (c: MatrixCase): Persona[] =>
        c.only ?? (c.access === "read" ? ["owner", "reader", "writer", "impersonated"] : ["owner", "writer", "impersonated"]);
    const auth = (req: any, persona: Persona, s: MatrixSeed) => req.set("Authorization", "jwt " + ctx.token(s.personas[persona]));
    const url = (path: string): string => `${ctx.prefix}${path}`;

    /** What "no" looks like: what "no" looks like is 403, 404 or a 200 that shows nothing. */
    const isDenied = (res: any): boolean => {
        if (res.status === 403 || res.status === 404) {
            return true;
        }
        if (res.status === 200 || res.status === 204) {
            const body: any = res.body;
            const empty: boolean = body === undefined || body === null || body === "" || (Array.isArray(body) && body.length === 0) || (typeof body === "object" && Object.keys(body).length === 0);
            return empty || Number(res.headers["content-length"]) === 0;
        }
        return false;
    };

    const seed = async (): Promise<MatrixSeed> => {
        const store = ctx.store();
        const personas = newPersonas();
        const owner = personas.owner;
        const grantee: string = uuid.v4();
        await store.save("Mailbox", {
            ownerUserUid: grantee,
            primarySmtpAddress: `grantee-${grantee}@example.com`,
            aliasAddresses: [],
            displayName: "Grantee",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
        });
        const marker: string = `secret-${uuid.v4()}`;
        const mailbox = await store.save("Mailbox", {
            ownerUserUid: owner.uid,
            primarySmtpAddress: `${marker}@example.com`,
            aliasAddresses: [],
            displayName: `Mailbox ${marker}`,
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
            oofMessage: `Away ${marker}`,
        });
        await store.saveAcl(mailbox.uid, "Mailbox", [
            { userOrRoleId: owner.uid, actions: ["*"] },
            { userOrRoleId: personas.reader.uid, actions: READ_ACTIONS },
            { userOrRoleId: personas.writer.uid, actions: WRITE_ACTIONS },
        ]);
        const folders: any = {};
        for (const [key, type] of [
            ["inbox", FolderType.INBOX],
            ["drafts", FolderType.DRAFTS],
            ["calendar", FolderType.CALENDAR],
            ["contacts", FolderType.CONTACTS],
            ["tasks", FolderType.TASKS],
            ["user", FolderType.USER],
        ] as const) {
            const folder = await store.save("Folder", { mailboxUid: mailbox.uid, name: `${key}`, type, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 });
            await store.saveAcl(folder.uid, mailbox.uid, []);
            folders[key] = folder;
        }
        const blobKey = `bodies/${uuid.v4()}`;
        await ctx.blobStore().put(blobKey, Buffer.from(`From: a@example.net\r\nTo: b@example.net\r\nSubject: ${marker}\r\nContent-Type: text/plain\r\n\r\nBody ${marker}\r\n`));
        const message = await store.save("Message", {
            mailboxUid: mailbox.uid,
            folderUid: folders.inbox.uid,
            messageId: `${uuid.v4()}@example.net`,
            subject: `Subject ${marker}`,
            from: { address: "a@example.net", type: RecipientType.TO },
            recipients: [{ address: mailbox.primarySmtpAddress, type: RecipientType.TO }],
            sentDate: new Date(),
            receivedDate: new Date(),
            bodyBlobKey: blobKey,
            sanitizedHtmlBlobKey: blobKey,
            bodyPreview: `Preview ${marker}`,
            flags: { read: false, flagged: false, answered: false, forwarded: false },
            importance: MessageImportance.NORMAL,
            references: [],
            hasAttachments: true,
            conversationId: `conv-${marker}`,
        });
        const attachmentKey = `attachments/${uuid.v4()}`;
        await ctx.blobStore().put(attachmentKey, Buffer.from(`attachment ${marker}`));
        const attachment = await store.save("Attachment", {
            messageUid: message.uid,
            folderUid: folders.inbox.uid,
            mailboxUid: mailbox.uid,
            filename: `${marker}.txt`,
            mimeType: "text/plain",
            sizeBytes: 20,
            blobKey: attachmentKey,
            isInline: false,
        });
        const s: MatrixSeed = { personas, grantee, marker, mailbox, folders, message, attachment, rows: {} };
        for (const kind of SCOPED_KINDS) {
            s.rows[kind.kind] = await store.save(kind.kind, {
                mailboxUid: mailbox.uid,
                ...(kind.scope === "folderUid" ? { folderUid: folders[kind.folder!].uid } : {}),
                ...kind.fields(s),
            });
        }
        s.rows.CalendarShareLink = await store.save("CalendarShareLink", {
            token: uuid.v4().replace(/-/g, "").padEnd(43, "x"),
            folderUid: folders.calendar.uid,
            permittedActions: ["read"],
            createdByUserUid: owner.uid,
        });
        s.rows.QuarantineEntry = await store.save("QuarantineEntry", {
            mailboxUid: mailbox.uid,
            reason: QuarantineReason.SPAM_POLICY,
            scanResultUid: uuid.v4(),
            rawBlobKey: `raw/${marker}`,
        });
        s.rows.IngestQueueEntry = await store.save("IngestQueueEntry", {
            mailboxUid: mailbox.uid,
            envelopeFrom: `${marker}@example.net`,
            envelopeTo: [mailbox.primarySmtpAddress],
            rawBlobKey: `raw/${marker}`,
        });
        return s;
    };

    const send = async (persona: Persona, r: MatrixRequest, s: MatrixSeed): Promise<any> => {
        const req: any = auth(request(ctx.app())[r.method](url(r.path)), persona, s);
        if (r.raw) {
            return await req.set("content-type", r.raw.type).send(r.raw.data);
        }
        return r.body === undefined ? await req : await req.send(r.body);
    };

    describe("Mailbox access matrix - only the owner and explicit ACL holders get in (an administrator included)", () => {
        // The reads share one seed: nothing they do changes it.
        let shared: MatrixSeed;
        beforeAll(async () => {
            shared = await seed();
        });

        for (const c of MATRIX_CASES) {
            for (const persona of PERSONAS) {
                const audited: boolean = persona === "admin" && !!c.adminAudited;
                const shouldGetIn: boolean = allowed(c).includes(persona) || audited;
                it(`${c.route} / ${c.name} - ${persona}: ${audited ? "allowed, audited" : c.adminNoOp && persona === "admin" ? "no effect" : shouldGetIn ? "allowed" : "denied"}`, async () => {
                    const s: MatrixSeed = c.access === "read" ? shared : await seed();
                    const res = await send(persona, c.request(s, ctx.prefix), s);
                    if (persona === "admin" && c.adminNoOp) {
                        // Answered with the mailbox's administrative metadata at most - never the owner's own settings.
                        expect(res.body?.oofMessage).toBeUndefined();
                        expect(res.body?.keys).toBeUndefined();
                        expect(await c.changed!(s, ctx.store(), ctx.findAcl), "the administrator's call must change nothing of the owner's").toBe(false);
                        return;
                    }
                    if (shouldGetIn) {
                        expect(c.success(res, s), `${persona} should have been let in; got ${res.status} ${JSON.stringify(res.body)?.slice(0, 200)}`).toBe(true);
                        if (audited) {
                            const entries = await ctx.store().find("AuditLogEntry", { mailboxUid: s.mailbox.uid });
                            expect(entries.map((e: any) => e.action)).toContain(c.adminAudited);
                        }
                        return;
                    }
                    expect(isDenied(res), `${persona} must be denied; got ${res.status} ${JSON.stringify(res.body)?.slice(0, 200)}`).toBe(true);
                    // Nothing of the mailbox's data comes back with a denial either.
                    expect(`${JSON.stringify(res.body ?? "")}${res.text ?? ""}`).not.toContain(s.marker);
                    if (c.changed) {
                        expect(await c.changed(s, ctx.store(), ctx.findAcl), "a denied write must change nothing").toBe(false);
                    }
                });
            }
        }
    });
}
