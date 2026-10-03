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
import * as crypto from "crypto";
import { ApiErrorMessages, ApiErrors, HttpRequest, ObjectFactory, RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { SearchEntityType, SearchProvider, SearchResultPage } from "../search/SearchProvider.js";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { requireEscrowHolder } from "../util/EscrowUtils.js";
import { AuditAction, Mailbox, Matter } from "../models/types.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;
const { Get, Query, RateLimit, Request, User: AuthUser } = RouteDecorators;

/** A review search is limited per user: each one runs a full-text query against every custodian mailbox of the matter. */
const SEARCH_MAX_ATTEMPTS: number = 60;
const SEARCH_WINDOW_SECONDS: number = 60;

/** Parses an ISO date-string query param, returning `undefined` for an absent/empty/unparseable value -
 * mirrors `BaseSearchRoute.ts`'s own identical helper. */
function parseDateParam(value: string | undefined): Date | undefined {
    if (!value) {
        return undefined;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Rejects (400) a structured search filter param given more than once - mirrors `BaseSearchRoute.ts`'s
 * identical helper/rationale: a repeated query key parses to a real array at runtime regardless of this
 * param's `string | undefined` type annotation, which every `.split(",")` use below would otherwise throw
 * an uncaught `TypeError` (an opaque 500) on, rather than the clean 400 a malformed request deserves. */
function assertSingleStringParam(value: unknown, name: string): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "string") {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'${name}' must be given at most once.`);
    }
    return value;
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
 * litigation hold's own defined scope. The clamp itself is nudged 1ms past each boundary before being
 * handed to a `SearchProvider`, since every provider's `before`/`after` are EXCLUSIVE while this codebase's
 * own authoritative `matterCovers()` is INCLUSIVE on both ends - see `search()`'s own inline comment. Unlike
 * `BaseSearchRoute`, this first pass offers no `cursor`-based
 * pagination (a single opaque cursor can't meaningfully paginate several independent per-mailbox result
 * sets at once) or a Tier 3 `/candidates` mode - both real, disclosed scope narrowings, not oversights,
 * left for a future pass if reviewing beyond one page per custodian turns out to matter in practice.
 *
 * A custodian mailbox is only ever actually searched when its own `Mailbox.escrowScopeId` matches this
 * matter's `escrowScopeId` - the same "both must agree" check `BaseEscrowAccessRequestRoute.create()`
 * already enforces before opening real escrow access (see `Matter.custodianMailboxUids`'s own doc
 * comment). `custodianMailboxUids` alone is holder-set, unvalidated free text (`BaseMatterRoute`'s own
 * `validateMatter()` only checks it's a non-empty array of non-empty strings) - without this check, any
 * holder of any `EscrowScope` could list an arbitrary mailbox as a "custodian" on their own matter and
 * search its full content, with no dual-control approval and no real relationship between that mailbox
 * and the scope at all. A mismatched/no-longer-existing mailbox is skipped with a warning, the same
 * tolerance `MatterExportJob`'s own per-custodian loop already shows.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseMatterSearchRoute<M extends Matter, MB extends Mailbox> {
    protected abstract matterClass: any;
    protected abstract escrowScopeClass: any;
    protected abstract mailboxClass: any;

    /** The concrete `AuditLogEntry` class, supplied by the Mongo/SQL subclasses. Unset: a search is not audited. */
    protected auditLogClass?: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    @Config()
    private config: any;

    protected matterRepo?: RepoUtils<M>;
    protected mailboxRepo?: RepoUtils<MB>;

    @Inject("SearchProvider")
    private searchProvider?: SearchProvider;

    @Logger
    private logger: any;

    @Init
    protected async initialize(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        if (!this.matterRepo && this.matterClass) {
            this.matterRepo = await this._objectFactory.newInstance(RepoUtils, {
                name: this.matterClass.name,
                args: [this.matterClass],
            });
        }
        if (!this.mailboxRepo && this.mailboxClass) {
            this.mailboxRepo = await this._objectFactory.newInstance(RepoUtils, {
                name: this.mailboxClass.name,
                args: [this.mailboxClass],
            });
        }
    }

    private async requireHolderMatter(matterId: string, user: JWTUser | undefined): Promise<M> {
        const matter: M | undefined = await this.matterRepo!.findOne(matterId, { ignoreACL: true });
        if (!matter) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        await requireEscrowHolder(this._objectFactory!, this.escrowScopeClass, matter.escrowScopeId, user);
        return matter;
    }

    @RateLimit({ perUser: true, maxAttempts: SEARCH_MAX_ATTEMPTS, windowSeconds: SEARCH_WINDOW_SECONDS })
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
        @Request req?: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<Record<string, SearchResultPage>> {
        if (!this.searchProvider) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        if (!matterId) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "matterId is required.");
        }
        // A repeated or nested query key reaches here as an array or object whatever the parameter is typed as: every filter is one string.
        text = assertSingleStringParam(text, "q");
        from = assertSingleStringParam(from, "from");
        to = assertSingleStringParam(to, "to");
        cc = assertSingleStringParam(cc, "cc");
        subject = assertSingleStringParam(subject, "subject");
        folderUid = assertSingleStringParam(folderUid, "in");
        limitParam = assertSingleStringParam(limitParam, "limit");
        hasAttachmentParam = assertSingleStringParam(hasAttachmentParam, "hasAttachment");
        beforeParam = assertSingleStringParam(beforeParam, "before");
        afterParam = assertSingleStringParam(afterParam, "after");
        typesParam = assertSingleStringParam(typesParam, "types");
        isParam = assertSingleStringParam(isParam, "is");
        labelParam = assertSingleStringParam(labelParam, "label");
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
        // A closed matter is over - its review authority ends with it, the same as for new escrow access requests
        // (`BaseEscrowAccessRequestRoute.create()`) and exports (`BaseMatterExportRequestRoute.create()`).
        if (matter.closedAt) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "This matter is closed.");
        }

        // `new Date()` rather than using the stored values directly: a matter saved on MongoDB before its dates
        // were coerced on write holds ISO strings (see `util/DateCoercionUtils.ts`).
        const rangeEnd: Date = new Date(matter.dateRangeEnd);
        const rangeStart: Date = new Date(matter.dateRangeStart);
        // This route's own authoritative definition of matter coverage (`LegalHoldUtils.matterCovers()`) is
        // INCLUSIVE on both ends (`>= dateRangeStart && <= dateRangeEnd`), but every `SearchProvider` treats
        // `before`/`after` as EXCLUSIVE (`< before`, `> after` - confirmed by reading each provider's own
        // query-building code, not assumed). Clamping straight to `rangeEnd`/`rangeStart` would silently drop
        // a message dated exactly on either boundary day from review search, even though it's genuinely within
        // the hold's scope - a real completeness gap for a compliance feature. Nudging the clamp boundaries by
        // 1ms compensates for the exclusive comparison without changing what a caller's OWN (already-narrower)
        // `before`/`after` means.
        const rangeEndInclusive: Date = new Date(rangeEnd.getTime() + 1);
        const rangeStartInclusive: Date = new Date(rangeStart.getTime() - 1);
        const requestedBefore: Date | undefined = parseDateParam(beforeParam);
        const requestedAfter: Date | undefined = parseDateParam(afterParam);
        const before: Date = requestedBefore && requestedBefore.getTime() < rangeEndInclusive.getTime() ? requestedBefore : rangeEndInclusive;
        const after: Date = requestedAfter && requestedAfter.getTime() > rangeStartInclusive.getTime() ? requestedAfter : rangeStartInclusive;

        const entityTypes: SearchEntityType[] | undefined = typesParam ? (typesParam.split(",") as SearchEntityType[]) : undefined;

        const mailboxRepo: RepoUtils<MB> = this.mailboxRepo!;
        const resultsByMailbox: Record<string, SearchResultPage> = {};
        // Read as a number of results per custodian: anything that isn't a positive whole number is no limit at all (the provider's own default applies).
        const limit: number | undefined = limitParam !== undefined && /^[1-9][0-9]{0,6}$/.test(limitParam) ? parseInt(limitParam, 10) : undefined;
        for (const mailboxUid of matter.custodianMailboxUids) {
            const mailbox: MB | undefined = await mailboxRepo.findOne(mailboxUid, { ignoreACL: true });
            if (!mailbox || mailbox.escrowScopeId !== matter.escrowScopeId) {
                this.logger?.warn(
                    `BaseMatterSearchRoute: skipping custodian mailbox ${mailboxUid} for matter ${matter.uid} - it no longer exists or is not actually assigned to this matter's escrow scope.`,
                );
                continue;
            }
            resultsByMailbox[mailboxUid] = await this.searchProvider.search({
                mailboxUid,
                text: text ?? "",
                entityTypes,
                limit,
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
        // Reading every custodian's mail is the point of a hold review, and the holder's own searches are what an audit has to be able to show:
        // the matter, how many mailboxes were searched and a digest of the query - not the text, which can itself be what is sensitive.
        if (this.auditLogClass) {
            await recordAuditLog(
                this._objectFactory!,
                this.auditLogClass,
                { config: this.config, req, user, logger: this.logger },
                {
                    action: AuditAction.MATTER_SEARCH,
                    targetType: "Matter",
                    targetUid: matter.uid,
                    details: {
                        custodianCount: Object.keys(resultsByMailbox).length,
                        queryDigest: crypto
                            .createHash("sha256")
                            .update(JSON.stringify([text, typesParam, from, to, cc, subject, hasAttachmentParam, beforeParam, afterParam, folderUid, isParam, labelParam]))
                            .digest("hex")
                            .slice(0, 16),
                    },
                },
            );
        }
        return resultsByMailbox;
    }
}
