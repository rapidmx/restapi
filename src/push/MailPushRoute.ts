///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import { ApiErrors, BasePushRoute } from "@rapidrest/service-core";
import { stripTrustedRoles } from "../util/MailAccessUtils.js";
const { Config } = ObjectDecorators;

/**
 * Real-time push notifications for the webmail client, built entirely on `service-core`'s own
 * `BasePushRoute` (WebSocket connect/subscribe/unsubscribe, Redis pub/sub fan-out) — no mail-specific override
 * is needed, since `BasePushRoute`'s channel model already matches this library's own permission model exactly.
 *
 * **No role widens a subscription.** `BasePushRoute` authorizes every SUBSCRIBE (and reconnect, and `POST /:id` publish)
 * through `ACLUtils.hasPermission()`, which answers `true` for any caller holding a trusted role - so an administrator
 * could subscribe to another user's folder or mailbox and receive its live `bodyPreview`/subject/sender payloads, or to any
 * other channel string at all. `connect()` and `send()` here hand the base class `stripTrustedRoles()` of the caller
 * (`util/MailAccessUtils.ts`), so a channel is granted only if it is the caller's own uid (always implicit) or the uid of a
 * mailbox/folder whose ACL gives THEM `READ` - by ownership or an explicit delegate record. An impersonation token is the
 * target user's own identity and works like theirs.
 *
 * **A published message's own `from` field (when present) can't claim a different identity than the authenticated
 * caller.** `CREATE` on the channel only ever authorizes publishing TO it - nothing about that authorizes a message
 * BODY claiming to have come from somebody else. `send()` below rejects (400) a mismatch - see its own doc comment.
 *
 * **Channels are bare entity uids** — a `Mailbox.uid` or a `Folder.uid`, the same uid `ACLUtils.hasPermission()`
 * is checked against everywhere else in this library — NOT a prefixed name like `"mailbox:<uid>"`.
 * `BasePushRoute.connect()`'s SUBSCRIBE handler calls `aclUtils.hasPermission(user, channel, ACLAction.READ)`
 * with the client-supplied channel value verbatim, so a client subscribes directly to the `uid` of whichever
 * `Mailbox`/`Folder` it wants live updates for — that uid resolves to the real `AccessControlList` document the
 * same way every other read in this library does, including the `parentUid` inheritance chain (subscribing to
 * a `Mailbox` uid a caller can read does NOT also deliver that mailbox's folders' events - each `Folder` is a
 * separate channel a client subscribes to independently, matching how `Folder`'s own ACL is a separate document
 * from its owning `Mailbox`'s).
 *
 * Publishing is done via `NotificationUtils.sendMessage(uids, type, action, data)` (`@Inject(NotificationUtils)`
 * in the base route classes) at the mutation call sites — see `BaseScopedChildRoute`/`BaseFolderRoute`/
 * `ScanQueueJob` for where this library calls it. A message arrives at a subscribed client as
 * `{type: "MESSAGE", channel, data: {type, action, data}}` (the outer envelope from `BasePushRoute`'s Redis
 * subscription forwarding, the inner `{type, action, data}` from `NotificationUtils.sendMessage()`).
 *
 * **Folder counts.** Whenever a write changes what a folder holds or which of it is read (a message created, marked
 * read/unread, moved, deleted, sent, imported, purged), the folder's counts are published on **both the folder's own
 * channel and its mailbox's** as
 * `{ type: "FolderMongo" | "FolderSQL", action: "update", data: { uid, mailboxUid, unreadCount, totalCount } }` - see
 * `util/FolderCountUtils.ts`. `data.uid` is the folder (the mailbox-channel copy names it too), and the counts are what
 * `GET /folders` would answer at that moment.
 *
 * !!Note!! like `BasePushRoute` itself, this class is not automatically registered with a server — the
 * consuming application must apply `@Route("/push")` (or any other chosen base path) to its own subclass:
 * ```ts
 * import { MailPushRoute } from "@rapidrest/mail";
 * import { RouteDecorators } from "@rapidrest/service-core";
 * const { Route } = RouteDecorators;
 *
 * @Route("/push")
 * export class PushRoute extends MailPushRoute {}
 * ```
 *
 * @author Jean-Philippe Steinmetz
 */
export class MailPushRoute extends BasePushRoute {
    @Config("trusted_roles", ["admin"])
    protected trustedRoles: string[] = ["admin"];

    /** `BasePushRoute.connect()` for the caller without their trusted roles - see this class's doc comment. */
    public async connect(sock: any, user: any): Promise<void> {
        return super.connect(sock, stripTrustedRoles(user as JWTUser, this.trustedRoles));
    }

    /** `BasePushRoute.send()` for the caller without their trusted roles: publishing to a channel needs `CREATE` on it as
     * an ordinary user would. Also rejects a published message whose own `msg.from` field (when present at all) doesn't
     * equal the authenticated caller's real uid - `BasePushRoute.send()` itself (read directly, not assumed) forwards
     * `msg` to every subscriber completely verbatim, with no validation of its contents whatsoever, only a permission
     * check on the CHANNEL being published to. Nothing stops an authenticated caller from claiming to BE someone else
     * inside the message body itself - at least one real consumer of this shared push channel (a WebRTC-signaling
     * plugin) trusts a message's own `from` field as the identity of whoever sent it, with no check of its own, letting
     * any channel participant forge a `bye`/presenter-claim/offer "from" another participant and have every other
     * client apply it as genuine. Deliberately property-agnostic - this checks `from` alone, never any consumer-
     * specific field name or message `type` - so it protects every current and future consumer of this route, not
     * just that one. Rejects rather than silently overwriting the field, matching `assertSenderAllowed()`'s identical
     * "loudly refuse a claimed identity that doesn't match the authenticated caller" convention elsewhere in this
     * library, rather than quietly rewriting a value a caller explicitly sent. */
    public async send(id: string, msg: any, user: any): Promise<void> {
        if (msg !== null && typeof msg === "object" && "from" in msg && msg.from !== (user as JWTUser | undefined)?.uid) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "A published message's own 'from' field must match the authenticated caller's uid.");
        }
        return super.send(id, msg, stripTrustedRoles(user as JWTUser, this.trustedRoles));
    }
}
