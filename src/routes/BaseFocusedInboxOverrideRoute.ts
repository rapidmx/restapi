///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, type JWTUser } from "@rapidrest/core";
import { ApiErrors, HttpRequest, RouteDecorators } from "@rapidrest/service-core";
import { normalizeAddress } from "../util/AddressUtils.js";
import { FocusedInboxOverride } from "../models/types.js";
import { BaseScopedChildRoute } from "./BaseScopedChildRoute.js";
const { Post, Request, User: AuthUser } = RouteDecorators;

/**
 * `mailboxUid`-scoped CRUD for `FocusedInboxOverride`, keeping one override per (mailbox, sender) with the sender
 * stored normalized (trimmed, lowercased) - the form `ScanQueueJob` looks overrides up by and
 * `BaseMessageRoute.classify()` writes. A create for a sender the mailbox already has an override for updates that
 * override's `classifyAs` instead of adding a second, contradictory one (the same upsert `classify()` does); an
 * update renaming an override onto another existing one's sender is refused (409).
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseFocusedInboxOverrideRoute<T extends FocusedInboxOverride> extends BaseScopedChildRoute<T> {
    protected readonly scopeProperty: string = "mailboxUid";

    private normalizeSender(obj: any): void {
        if (obj.senderAddress === undefined) {
            return;
        }
        if (typeof obj.senderAddress !== "string" || normalizeAddress(obj.senderAddress).length === 0) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'senderAddress' must be an address.");
        }
        obj.senderAddress = normalizeAddress(obj.senderAddress);
    }

    private async findForSender(mailboxUid: string, senderAddress: string): Promise<T | undefined> {
        const found: T[] = await this.repoUtils!.find(
            { mailboxUid: `eq(${mailboxUid})`, senderAddress: `eq(${senderAddress})`, limit: 1 } as any,
            { ignoreACL: true, limit: 1 },
        );
        return found[0];
    }

    @Post()
    public async create(obj: T | T[], @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T | T[]> {
        if (Array.isArray(obj)) {
            const results: T[] = [];
            for (const single of obj) {
                results.push((await this.create(single, req, user)) as T);
            }
            return results;
        }
        this.normalizeSender(obj);
        const existing: T | undefined =
            typeof obj.mailboxUid === "string" && typeof obj.senderAddress === "string"
                ? await this.findForSender(obj.mailboxUid, obj.senderAddress)
                : undefined;
        if (existing) {
            // `update()` re-checks the caller's permission on the existing override's mailbox.
            return await this.update(existing.uid, { uid: existing.uid, version: existing.version, classifyAs: obj.classifyAs } as any, req, user);
        }
        return await super.create(obj, req, user);
    }

    protected async prepareUpdate(obj: any, existing: T, user: JWTUser | undefined): Promise<void> {
        await super.prepareUpdate(obj, existing, user);
        this.normalizeSender(obj);
        const mailboxUid: string = obj.mailboxUid ?? existing.mailboxUid;
        const senderAddress: string = obj.senderAddress ?? existing.senderAddress;
        if (mailboxUid !== existing.mailboxUid || senderAddress !== existing.senderAddress) {
            const other: T | undefined = await this.findForSender(mailboxUid, senderAddress);
            if (other && other.uid !== existing.uid) {
                throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, "This mailbox already has an override for that sender.");
            }
        }
    }
}
