///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import { ACLAction, ACLUtils, ApiErrorMessages, ApiErrors, DocDecorators, ObjectFactory, RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { CandidateResultPage, SearchEntityType, SearchProvider, SearchResultPage } from "../search/SearchProvider.js";
import { resolveCallerMailboxUid } from "../util/MailboxScopeUtils.js";
import { Mailbox } from "../models/types.js";
const { Inject, Logger } = ObjectDecorators;
const { Description, Returns, Summary } = DocDecorators;
const { Auth, Get, Query, User: AuthUser } = RouteDecorators;

/** Parses an ISO date-string query param, returning `undefined` for an absent/empty/unparseable value rather
 * than an `Invalid Date` silently reaching the provider layer. */
function parseDateParam(value: string | undefined): Date | undefined {
    if (!value) {
        return undefined;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Exposes full-text search across a mailbox's messages/contacts/calendar events/notes/tasks. Unlike every
 * other route in this library, this is NOT a `ModelRoute`/`CRUDRoute` subclass — `RepoUtils.find()` has no
 * full-text query capability, so this route calls the injected `SearchProvider` directly instead.
 *
 * `mailboxClass` is supplied by the Mongo/SQL concrete subclasses. Search is scoped to exactly one mailbox: by
 * default the one the requesting user owns (`ownerUserUid === user.uid`); with `?mailboxUid=`, that mailbox, provided
 * the caller has `READ` on it (its owner, a delegate it's shared with, or a trusted caller) - otherwise 404, the same
 * answer as a mailbox that doesn't exist. That's how a shared mailbox is searched.
 *
 * The structured filter query params below (`from`/`to`/`cc`/`subject`/`hasAttachment`/`before`/`after`/`in`/
 * `is`) are `specs/search.md` §14's operator grammar — `from:bob has:attachment` — already parsed into
 * discrete params by the caller (a webmail/mobile/desktop client), not parsed from raw text here. This route
 * only ever receives the already-structured result, so every tier a client might implement (its own local
 * Tier 2/3 search included) interprets the grammar identically. `q` (free text) is now optional: a query may
 * be pure filters (e.g. `subject:budget` with no free text at all), but at least one of `q` or a structured
 * filter must be present.
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

    @Inject(ACLUtils)
    private aclUtils?: ACLUtils;

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

    /** The mailbox to search: `requestedMailboxUid` if given and readable by `user` (else 404), otherwise the caller's
     * own. */
    private async requireCallerMailboxUid(user: JWTUser | undefined, requestedMailboxUid?: unknown): Promise<string> {
        if (!user) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }
        const mailboxRepo: RepoUtils<M> = await this.getMailboxRepo();
        if (requestedMailboxUid !== undefined) {
            if (typeof requestedMailboxUid !== "string" || requestedMailboxUid.length === 0) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
            }
            const mailbox: M | undefined = await mailboxRepo.findOne(requestedMailboxUid, { ignoreACL: true });
            if (!mailbox || !this.aclUtils || !(await this.aclUtils.hasPermission(user, mailbox.uid, ACLAction.READ))) {
                throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
            }
            return mailbox.uid;
        }
        const mailboxUid: string | undefined = await resolveCallerMailboxUid(mailboxRepo, user);
        if (!mailboxUid) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        return mailboxUid;
    }

    @Summary("Search mailbox")
    @Description("Performs a full-text search across the requesting user's mail, contacts, calendar, notes, and tasks.")
    @Returns([Object])
    @Auth(["jwt"])
    @Get()
    public async search(
        @Query("q") text: string | undefined,
        @Query("types") typesParam: string | undefined,
        @Query("cursor") cursor: string | undefined,
        @Query("limit") limitParam: string | undefined,
        @Query("from") from: string | undefined,
        @Query("to") to: string | undefined,
        @Query("cc") cc: string | undefined,
        @Query("subject") subject: string | undefined,
        @Query("hasAttachment") hasAttachmentParam: string | undefined,
        @Query("before") beforeParam: string | undefined,
        @Query("after") afterParam: string | undefined,
        @Query("in") folderUid: string | undefined,
        @Query("is") isParam: string | undefined,
        @Query("label") labelParam: string | undefined,
        @AuthUser user?: JWTUser,
        @Query("mailboxUid") mailboxUidParam?: string,
    ): Promise<SearchResultPage> {
        if (!this.searchProvider) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const hasStructuredFilter: boolean =
            from !== undefined ||
            to !== undefined ||
            cc !== undefined ||
            subject !== undefined ||
            hasAttachmentParam !== undefined ||
            beforeParam !== undefined ||
            afterParam !== undefined ||
            folderUid !== undefined ||
            isParam !== undefined ||
            labelParam !== undefined ||
            typesParam !== undefined;
        if (!text && !hasStructuredFilter) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }

        const mailboxUid: string = await this.requireCallerMailboxUid(user, mailboxUidParam);

        const entityTypes: SearchEntityType[] | undefined = typesParam
            ? (typesParam.split(",") as SearchEntityType[])
            : undefined;

        return await this.searchProvider.search({
            mailboxUid,
            text: text ?? "",
            entityTypes,
            cursor,
            limit: limitParam ? parseInt(limitParam, 10) : undefined,
            from,
            to,
            cc,
            subject,
            hasAttachment: hasAttachmentParam !== undefined ? hasAttachmentParam === "true" : undefined,
            before: parseDateParam(beforeParam),
            after: parseDateParam(afterParam),
            folderUid,
            flags: isParam ? isParam.split(",") : undefined,
            labels: labelParam ? labelParam.split(",") : undefined,
        });
    }

    /**
     * Tier 3 candidate narrowing (`specs/search.md` §6/§12) — identifiers only, ranked purely on server-
     * visible metadata, never on `subject`/`body`/`attachmentText`. `participants` narrows on `from`/`to`/`cc`/
     * `participants`; a client uses this for an encrypted entity outside its local Tier 2 index window, then
     * fetches/decrypts/matches each candidate locally.
     */
    @Summary("Tier 3 search candidates")
    @Description(
        "Returns a candidate set of entity identifiers for the requesting user's mailbox, ranked only on " +
            "server-visible metadata (participants, dates, folder, flags) - never on message content.",
    )
    @Returns([Object])
    @Auth(["jwt"])
    @Get("/candidates")
    public async candidates(
        @Query("types") typesParam: string | undefined,
        @Query("participants") participantsParam: string | undefined,
        @Query("before") beforeParam: string | undefined,
        @Query("after") afterParam: string | undefined,
        @Query("in") folderUid: string | undefined,
        @Query("is") isParam: string | undefined,
        @Query("label") labelParam: string | undefined,
        @Query("cursor") cursor: string | undefined,
        @Query("limit") limitParam: string | undefined,
        @AuthUser user?: JWTUser,
        @Query("mailboxUid") mailboxUidParam?: string,
    ): Promise<CandidateResultPage> {
        if (!this.searchProvider) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }

        const mailboxUid: string = await this.requireCallerMailboxUid(user, mailboxUidParam);

        const entityTypes: SearchEntityType[] | undefined = typesParam
            ? (typesParam.split(",") as SearchEntityType[])
            : undefined;

        return await this.searchProvider.candidates({
            mailboxUid,
            entityTypes,
            participants: participantsParam ? participantsParam.split(",") : undefined,
            before: parseDateParam(beforeParam),
            after: parseDateParam(afterParam),
            folderUid,
            flags: isParam ? isParam.split(",") : undefined,
            labels: labelParam ? labelParam.split(",") : undefined,
            cursor,
            limit: limitParam ? parseInt(limitParam, 10) : undefined,
        });
    }
}
