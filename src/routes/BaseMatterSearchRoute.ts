///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The consuming application must apply `@Route("/matter-search")` to its own concrete subclass (see
// `BaseDataExportRoute`/`BaseMailIngestRoute`'s identical note) - every method here is defined relative to
// that. `matterId` is a query param rather than a `:id` path segment - `BaseMatterRoute` (the ordinary
// `@Model`-driven CRUD route for `Matter` itself) already owns the `/matters` path prefix, and this
// framework mounts one concrete class per `@Route` prefix, so a second, bespoke class can't also claim
// `/matters/:id/search` without colliding with it.
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import { ApiErrorMessages, ApiErrors, ObjectFactory, RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { SearchEntityType, SearchProvider, SearchResultPage } from "../search/SearchProvider.js";
import { requireEscrowHolder } from "../util/EscrowUtils.js";
import { Matter } from "../models/types.js";
const { Inject, Logger } = ObjectDecorators;
const { Get, Query, User: AuthUser } = RouteDecorators;

/** Parses an ISO date-string query param, returning `undefined` for an absent/empty/unparseable value -
 * mirrors `BaseSearchRoute.ts`'s own identical helper. */
function parseDateParam(value: string | undefined): Date | undefined {
    if (!value) {
        return undefined;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * eDiscovery review search: full-text search across every one of a `Matter`'s custodian mailboxes at
 * once, for a holder of its `EscrowScope` - the second of the two gaps this roadmap's Group F closes
 * beyond what Escrow Scoping already shipped (the first is `BaseMatterExportRequestRoute`). Reuses the
 * existing `SearchProvider` abstraction unchanged - no new search backend work - calling `search()` once
 * per custodian mailbox and returning each mailbox's own result page keyed by `mailboxUid`, rather than
 * inventing a merged cross-mailbox ranking/cursor scheme this codebase has no spec for. A holder-facing
 * review UI groups results by custodian anyway (e.g. a per-custodian side panel), which this shape maps
 * onto directly.
 *
 * `before`/`after` are ALWAYS clamped to the matter's own `dateRangeStart`/`dateRangeEnd` - regardless of
 * what the caller supplies (including nothing at all) - so a holder can never widen review beyond the
 * litigation hold's own defined scope. Unlike `BaseSearchRoute`, this first pass offers no `cursor`-based
 * pagination (a single opaque cursor can't meaningfully paginate several independent per-mailbox result
 * sets at once) or a Tier 3 `/candidates` mode - both real, disclosed scope narrowings, not oversights,
 * left for a future pass if reviewing beyond one page per custodian turns out to matter in practice.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseMatterSearchRoute<M extends Matter> {
    protected abstract matterClass: any;
    protected abstract escrowScopeClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private matterRepo?: RepoUtils<M>;

    @Inject("SearchProvider")
    private searchProvider?: SearchProvider;

    @Logger
    private logger: any;

    private async getMatterRepo(): Promise<RepoUtils<M>> {
        if (!this.matterRepo) {
            this.matterRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.matterClass.name,
                args: [this.matterClass],
            });
        }
        return this.matterRepo;
    }

    private async requireHolderMatter(matterId: string, user: JWTUser | undefined): Promise<M> {
        const matterRepo: RepoUtils<M> = await this.getMatterRepo();
        const matter: M | undefined = await matterRepo.findOne(matterId, { ignoreACL: true });
        if (!matter) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        await requireEscrowHolder(this._objectFactory!, this.escrowScopeClass, matter.escrowScopeId, user);
        return matter;
    }

    @Get()
    public async search(
        @Query("matterId") matterId: string | undefined,
        @Query("q") text: string | undefined,
        @Query("types") typesParam: string | undefined,
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
    ): Promise<Record<string, SearchResultPage>> {
        if (!this.searchProvider) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        if (!matterId) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "matterId is required.");
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
            isParam !== undefined;
        if (!text && !hasStructuredFilter) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }

        const matter: M = await this.requireHolderMatter(matterId, user);

        const requestedBefore: Date | undefined = parseDateParam(beforeParam);
        const requestedAfter: Date | undefined = parseDateParam(afterParam);
        const before: Date = requestedBefore && requestedBefore.getTime() < matter.dateRangeEnd.getTime() ? requestedBefore : matter.dateRangeEnd;
        const after: Date =
            requestedAfter && requestedAfter.getTime() > matter.dateRangeStart.getTime() ? requestedAfter : matter.dateRangeStart;

        const entityTypes: SearchEntityType[] | undefined = typesParam ? (typesParam.split(",") as SearchEntityType[]) : undefined;

        const resultsByMailbox: Record<string, SearchResultPage> = {};
        for (const mailboxUid of matter.custodianMailboxUids) {
            resultsByMailbox[mailboxUid] = await this.searchProvider.search({
                mailboxUid,
                text: text ?? "",
                entityTypes,
                limit: limitParam ? parseInt(limitParam, 10) : undefined,
                from,
                to,
                cc,
                subject,
                hasAttachment: hasAttachmentParam !== undefined ? hasAttachmentParam === "true" : undefined,
                before,
                after,
                folderUid,
                flags: isParam ? isParam.split(",") : undefined,
                labels: labelParam ? labelParam.split(",") : undefined,
            });
        }
        return resultsByMailbox;
    }
}
