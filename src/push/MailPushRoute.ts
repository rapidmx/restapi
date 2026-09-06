///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { BasePushRoute } from "@rapidrest/service-core";

/**
 * Real-time push notifications for the webmail client, built entirely on `service-core`'s own
 * `BasePushRoute` (WebSocket connect/subscribe/unsubscribe, Redis pub/sub fan-out) — no mail-specific override
 * is needed, since `BasePushRoute`'s channel model already matches this library's own permission model exactly.
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
export class MailPushRoute extends BasePushRoute {}
