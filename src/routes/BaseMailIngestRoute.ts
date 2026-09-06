///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import {
    ApiErrorMessages,
    ApiErrors,
    DocDecorators,
    HttpRequest,
    HttpResponse,
    ObjectFactory,
    RepoUtils,
    RouteDecorators,
} from "@rapidrest/service-core";
import { BlobStore } from "../blob/BlobStore.js";
import { IngestQueueEntry, IngestStatus, Mailbox } from "../models/types.js";
const { Config, Inject, Logger } = ObjectDecorators;
const { Description, Summary } = DocDecorators;
const { Get, Post, Query, Request, Response } = RouteDecorators;

/**
 * Implements the `MTAIngestAdapter` HTTP contract (see `transport/MTAIngestAdapter.ts`) that the deployment's
 * MTA (Postfix, Haraka, ...) integrates against to hand accepted internet mail to this library. Both endpoints
 * are internal-only — never exposed to the public internet — and gated by a shared bearer secret rather than
 * ordinary user JWT auth, since the caller is the MTA process, not an end user.
 *
 * This class is DB-agnostic; `mailboxClass`/`ingestQueueClass` are supplied by the Mongo/SQL concrete
 * subclasses (`MailIngestRouteMongo`/`MailIngestRouteSQL`), following the same pattern
 * `DefaultAccounts`/`DefaultAccountsMongo` use for a background service spanning multiple entity types.
 *
 * !!Note!! that, like `BasePushRoute`/`BaseStatusRoute`, this class is not automatically registered with a
 * server — the consuming application must apply `@Route("/internal/mta")` to its own subclass. The
 * `MTAIngestAdapter` doc comment's `GET /internal/mta/resolve`/`POST /internal/mta/deliver` paths assume that
 * exact base path is used; if a deployment mounts it elsewhere, its MTA content-filter/lookup configuration
 * must be updated to match.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseMailIngestRoute<M extends Mailbox, Q extends IngestQueueEntry> {
    protected abstract mailboxClass: any;
    protected abstract ingestQueueClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private mailboxRepo?: RepoUtils<M>;
    private ingestQueueRepo?: RepoUtils<Q>;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    @Config("mail:transport:ingest:secret")
    private ingestSecret?: string;

    @Logger
    private logger: any;

    /**
     * Builds the query value used to match `Mailbox.aliasAddresses` against the given address. MongoDB's
     * implicit array-element equality lets a plain value match "array contains" directly, so the default here
     * is a no-op passthrough. `MailIngestRouteSQL` overrides this: the SQL backend stores `aliasAddresses` as a
     * serialized `simple-json` column, where a plain equality filter compares against the whole serialized
     * string and never matches a single element.
     */
    protected aliasQueryValue(address: string): any {
        return address;
    }

    private async init() {
        if (!this.mailboxRepo) {
            this.mailboxRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.mailboxClass.name,
                args: [this.mailboxClass],
            });
        }
        if (!this.ingestQueueRepo) {
            this.ingestQueueRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.ingestQueueClass.name,
                args: [this.ingestQueueClass],
            });
        }
    }

    /**
     * Verifies the caller presented the configured internal bearer secret. Deliberately not `@Auth(["jwt"])` —
     * the caller is the local MTA process, not an end user with a JWT. Throws `403` if no secret is configured
     * at all (fail closed, never fail open into an unauthenticated internal endpoint).
     */
    private authorizeInternalCaller(req: HttpRequest): void {
        const header: string | string[] | undefined = req.headers["authorization"];
        const presented: string = (Array.isArray(header) ? header[0] : header)?.replace(/^Bearer\s+/i, "") ?? "";
        const expected: string = this.ingestSecret ?? "";

        const presentedBuf: Buffer = Buffer.from(presented);
        const expectedBuf: Buffer = Buffer.from(expected);
        const authorized: boolean =
            expected.length > 0 &&
            presentedBuf.length === expectedBuf.length &&
            crypto.timingSafeEqual(presentedBuf, expectedBuf);

        if (!authorized) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
    }

    @Summary("Resolve recipient")
    @Description(
        "Called by the MTA's recipient-validation hook before accepting a message. Responds 200 if a mailbox " +
            "exists for the given address, 404 otherwise.",
    )
    @Get("/resolve")
    public async resolve(
        @Query("rcpt") rcpt: string,
        @Request req: HttpRequest,
        @Response res: HttpResponse,
    ): Promise<HttpResponse> {
        this.authorizeInternalCaller(req);
        await this.init();

        if (!rcpt) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }
        const address: string = rcpt.trim().toLowerCase();

        const [byPrimary, byAlias] = await Promise.all([
            this.mailboxRepo!.find({ primarySmtpAddress: address }, { ignoreACL: true, limit: 1 }),
            this.mailboxRepo!.find({ aliasAddresses: this.aliasQueryValue(address) }, { ignoreACL: true, limit: 1 }),
        ]);

        return byPrimary.length > 0 || byAlias.length > 0 ? res.status(200) : res.status(404);
    }

    @Summary("Deliver message")
    @Description(
        "Called by the MTA's content-filter once a message has been accepted. Persists the raw message and " +
            "enqueues it for scanning/delivery, then returns immediately.",
    )
    @Post("/deliver")
    public async deliver(@Request req: HttpRequest, @Response res: HttpResponse): Promise<HttpResponse> {
        this.authorizeInternalCaller(req);
        await this.init();

        if (!this.blobStore) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }

        const envelopeFrom: string = firstHeader(req, "x-envelope-from") ?? "";
        const envelopeToHeader: string | undefined = firstHeader(req, "x-envelope-to");
        const envelopeTo: string[] = envelopeToHeader ? envelopeToHeader.split(",").map((a) => a.trim()) : [];
        const raw: Buffer | undefined = req.rawBody;

        if (!raw || raw.length === 0 || envelopeTo.length === 0) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }

        // A single SMTP transaction can carry more than one RCPT TO — resolve and stage one IngestQueueEntry
        // per addressed mailbox so `ScanQueueJob` delivers independently to each, and one unknown/unresolvable
        // recipient in the batch doesn't block delivery to the others.
        const results: { rcpt: string; queued: boolean }[] = [];
        for (const rcpt of envelopeTo) {
            const address: string = rcpt.trim().toLowerCase();
            const mailboxes: M[] = await this.mailboxRepo!.find(
                { primarySmtpAddress: address },
                { ignoreACL: true, limit: 1 },
            );
            const mailbox: M | undefined =
                mailboxes[0] ??
                (
                    await this.mailboxRepo!.find(
                        { aliasAddresses: this.aliasQueryValue(address) },
                        { ignoreACL: true, limit: 1 },
                    )
                )[0];

            if (!mailbox) {
                this.logger?.warn(`MailIngestRoute: dropping delivery for unresolvable recipient '${address}'.`);
                results.push({ rcpt: address, queued: false });
                continue;
            }

            const rawBlobKey: string = `ingest/${crypto.randomUUID()}`;
            await this.blobStore.put(rawBlobKey, raw, { contentType: "message/rfc822" });

            await this.ingestQueueRepo!.create(
                new this.ingestQueueClass({
                    mailboxUid: mailbox.uid,
                    envelopeFrom,
                    envelopeTo: [address],
                    rawBlobKey,
                    status: IngestStatus.PENDING,
                }),
                { ignoreACL: true },
            );
            results.push({ rcpt: address, queued: true });
        }

        res.status(202).json({ results });
        return res;
    }
}

function firstHeader(req: HttpRequest, name: string): string | undefined {
    const value: string | string[] | undefined = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
}
