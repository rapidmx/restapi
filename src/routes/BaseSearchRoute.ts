///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import { ApiErrorMessages, ApiErrors, DocDecorators, ObjectFactory, RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { SearchEntityType, SearchProvider, SearchResultPage } from "../search/SearchProvider.js";
import { resolveCallerMailboxUid } from "../util/MailboxScopeUtils.js";
import { Mailbox } from "../models/types.js";
const { Inject, Logger } = ObjectDecorators;
const { Description, Returns, Summary } = DocDecorators;
const { Auth, Get, Query, User: AuthUser } = RouteDecorators;

/**
 * Exposes full-text search across a mailbox's messages/contacts/calendar events/notes/tasks. Unlike every
 * other route in this library, this is NOT a `ModelRoute`/`CRUDRoute` subclass — `RepoUtils.find()` has no
 * full-text query capability, so this route calls the injected `SearchProvider` directly instead.
 *
 * `mailboxClass` is supplied by the Mongo/SQL concrete subclasses. Search is always scoped to a mailbox the
 * requesting user owns (`ownerUserUid === user.uid`) — a client-supplied `mailboxUid` is deliberately not
 * accepted, so this endpoint can never be used to search another user's mailbox.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseSearchRoute<M extends Mailbox> {
    protected abstract mailboxClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private mailboxRepo?: RepoUtils<M>;

    @Inject("SearchProvider")
    private searchProvider?: SearchProvider;

    @Logger
    private logger: any;

    private async getMailboxRepo(): Promise<RepoUtils<M>> {
        if (!this.mailboxRepo) {
            this.mailboxRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.mailboxClass.name,
                args: [this.mailboxClass],
            });
        }
        return this.mailboxRepo;
    }

    @Summary("Search mailbox")
    @Description("Performs a full-text search across the requesting user's mail, contacts, calendar, notes, and tasks.")
    @Returns([Object])
    @Auth(["jwt"])
    @Get()
    public async search(
        @Query("q") text: string,
        @Query("types") typesParam: string | undefined,
        @Query("cursor") cursor: string | undefined,
        @Query("limit") limitParam: string | undefined,
        @AuthUser user?: JWTUser,
    ): Promise<SearchResultPage> {
        if (!this.searchProvider) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        if (!text || !user) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }

        const mailboxRepo: RepoUtils<M> = await this.getMailboxRepo();
        const mailboxUid: string | undefined = await resolveCallerMailboxUid(mailboxRepo, user);
        if (!mailboxUid) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }

        const entityTypes: SearchEntityType[] | undefined = typesParam
            ? (typesParam.split(",") as SearchEntityType[])
            : undefined;

        return await this.searchProvider.search({
            mailboxUid,
            text,
            entityTypes,
            cursor,
            limit: limitParam ? parseInt(limitParam, 10) : undefined,
        });
    }
}
