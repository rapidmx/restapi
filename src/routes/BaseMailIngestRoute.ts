///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
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
import type { MailTransport } from "../transport/MailTransport.js";
import { DistributionList, IngestQueueEntry, IngestStatus, Mailbox, QuarantineReason, TransportRule } from "../models/types.js";
import { normalizeAddress } from "../util/AddressUtils.js";
import { rewriteHeadersForList } from "../util/DistributionListUtils.js";
import { getVerifiedDomainNames } from "../util/DomainUtils.js";
import { extractHeader, prependHeaders } from "../util/MimeHeaderUtils.js";
import { buildTransportRuleContext, evaluateTransportRules } from "../util/TransportRuleUtils.js";
const { Config, Inject, Logger } = ObjectDecorators;
const { Description, Summary } = DocDecorators;
const { Get, Post, Query, Request, Response } = RouteDecorators;

/**
 * Implements the `MTAIngestAdapter` HTTP contract (see `transport/MTAIngestAdapter.ts`) that the deployment's
 * MTA (Postfix, Haraka, ...) integrates against to hand accepted internet mail to this library. Both endpoints
 * are internal-only — never exposed to the public internet — and gated by a shared bearer secret rather than
 * ordinary user JWT auth, since the caller is the MTA process, not an end user.
 *
 * This class is DB-agnostic; `mailboxClass`/`ingestQueueClass`/`distributionListClass`/`transportRuleClass`/
 * `domainClass` are supplied by the Mongo/SQL concrete subclasses (`MailIngestRouteMongo`/`MailIngestRouteSQL`), following
 * the same pattern `DefaultAccounts`/`DefaultAccountsMongo` use for a background service spanning multiple
 * entity types.
 *
 * A recipient address can resolve to a `Mailbox` (delivered directly, as before) or a `DistributionList`
 * (expanded recursively to its member `Mailbox`es and/or genuinely external addresses - see
 * `expandDistributionList()`). Internal fan-out still produces exactly one `IngestQueueEntry` per resolved
 * mailbox, all sharing a single blob-stored copy of the (list-header-rewritten) message; external members are
 * relayed directly via `MailTransport`, bypassing the ingest queue entirely - a distribution list is not itself
 * a "mailbox" `ScanQueueJob` ever delivers to.
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
    protected abstract distributionListClass: any;
    protected abstract transportRuleClass: any;
    protected abstract domainClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private mailboxRepo?: RepoUtils<M>;
    private ingestQueueRepo?: RepoUtils<Q>;
    private distributionListRepo?: RepoUtils<DistributionList>;
    private transportRuleRepo?: RepoUtils<TransportRule>;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    @Inject("MailTransport")
    private mailTransport?: MailTransport;

    @Config("mail:transport:ingest:secret")
    private ingestSecret?: string;

    /** Caps how deeply nested distribution lists (a list whose own member is another list) are expanded - a
     * cheap safety net on top of the real cycle guard (`visitedListUids`), which already prevents a true A→B→A
     * loop from hanging or double-delivering. */
    @Config("mail:distribution_lists:max_depth", 10)
    private maxListDepth: number = 10;

    @Logger
    private logger: any;

    /**
     * Builds the query value used to match `Mailbox.aliasAddresses`/`DistributionList.aliasAddresses` against
     * the given address. MongoDB's implicit array-element equality lets a plain value match "array contains"
     * directly, so the default here is a no-op passthrough. `MailIngestRouteSQL` overrides this: the SQL
     * backend stores `aliasAddresses` as a serialized `simple-json` column, where a plain equality filter
     * compares against the whole serialized string and never matches a single element.
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
        if (!this.distributionListRepo) {
            this.distributionListRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.distributionListClass.name,
                args: [this.distributionListClass],
            });
        }
        if (!this.transportRuleRepo) {
            this.transportRuleRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.transportRuleClass.name,
                args: [this.transportRuleClass],
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

    private async findMailboxByAddress(address: string): Promise<M | undefined> {
        const mailboxes: M[] = await this.mailboxRepo!.find({ primarySmtpAddress: address }, { ignoreACL: true, limit: 1 });
        return (
            mailboxes[0] ??
            (await this.mailboxRepo!.find({ aliasAddresses: this.aliasQueryValue(address) }, { ignoreACL: true, limit: 1 }))[0]
        );
    }

    private async findDistributionListByAddress(address: string): Promise<DistributionList | undefined> {
        const lists: DistributionList[] = await this.distributionListRepo!.find(
            { primarySmtpAddress: address },
            { ignoreACL: true, limit: 1 },
        );
        return (
            lists[0] ??
            (
                await this.distributionListRepo!.find(
                    { aliasAddresses: this.aliasQueryValue(address) },
                    { ignoreACL: true, limit: 1 },
                )
            )[0]
        );
    }

    /**
     * Recursively resolves a `DistributionList`'s `memberAddresses` to internal `Mailbox`es and/or genuinely
     * external addresses. A member matching neither an internal `Mailbox` nor another `DistributionList` is
     * external by construction - membership was explicitly configured by an admin (see
     * `BaseDistributionListRoute`), so this is never reinterpreted as "unresolvable, drop it" the way an
     * unrecognized *top-level* recipient is in `deliver()`.
     *
     * `visitedListUids` guards against a nested cycle (list A contains list B, which contains list A) - a
     * revisited list is logged and skipped rather than recursed into again. `maxListDepth` is a cheap
     * additional safety net against a very long (non-cyclic) chain.
     */
    private async expandDistributionList(
        list: DistributionList,
        envelopeFromNormalized: string,
        visitedListUids: Set<string>,
        depth: number,
    ): Promise<{ mailboxes: M[]; externalAddresses: string[] }> {
        if (depth > this.maxListDepth) {
            this.logger?.warn(`MailIngestRoute: distribution list expansion exceeded max depth at '${list.primarySmtpAddress}'.`);
            return { mailboxes: [], externalAddresses: [] };
        }
        if (
            list.restrictSenders &&
            !(list.memberAddresses ?? []).some((m) => normalizeAddress(m) === envelopeFromNormalized)
        ) {
            this.logger?.warn(
                `MailIngestRoute: dropping expansion of restricted list '${list.primarySmtpAddress}' for non-member sender.`,
            );
            return { mailboxes: [], externalAddresses: [] };
        }

        const selfAddress: string = normalizeAddress(list.primarySmtpAddress);
        const mailboxes: M[] = [];
        const seenMailboxUids: Set<string> = new Set();
        const externalAddresses: string[] = [];
        const seenExternal: Set<string> = new Set();

        for (const rawMember of list.memberAddresses ?? []) {
            const member: string = normalizeAddress(rawMember);
            if (member === selfAddress) {
                continue;
            }

            const mailbox: M | undefined = await this.findMailboxByAddress(member);
            if (mailbox) {
                if (!seenMailboxUids.has(mailbox.uid)) {
                    seenMailboxUids.add(mailbox.uid);
                    mailboxes.push(mailbox);
                }
                continue;
            }

            const nestedList: DistributionList | undefined = await this.findDistributionListByAddress(member);
            if (nestedList) {
                if (visitedListUids.has(nestedList.uid)) {
                    this.logger?.warn(`MailIngestRoute: skipping distribution list cycle at '${nestedList.primarySmtpAddress}'.`);
                    continue;
                }
                visitedListUids.add(nestedList.uid);
                const nested = await this.expandDistributionList(nestedList, envelopeFromNormalized, visitedListUids, depth + 1);
                for (const mb of nested.mailboxes) {
                    if (!seenMailboxUids.has(mb.uid)) {
                        seenMailboxUids.add(mb.uid);
                        mailboxes.push(mb);
                    }
                }
                for (const ext of nested.externalAddresses) {
                    if (!seenExternal.has(ext)) {
                        seenExternal.add(ext);
                        externalAddresses.push(ext);
                    }
                }
                continue;
            }

            if (!seenExternal.has(member)) {
                seenExternal.add(member);
                externalAddresses.push(member);
            }
        }

        return { mailboxes, externalAddresses };
    }

    /**
     * Removes an unsubscribing member from a list (triggered by `deliver()` seeing a `Subject: unsubscribe`
     * message from a current member, addressed to the list itself) and sends a short confirmation - mirrors
     * the system-generated, bypass-`scanAndRelay` pattern already used for auto-replies/iTIP elsewhere in this
     * library. Best-effort: a failure to send the confirmation is logged, not propagated (the unsubscribe
     * itself has already been persisted by that point).
     */
    private async handleUnsubscribe(list: DistributionList, envelopeFrom: string): Promise<void> {
        const normalizedFrom: string = normalizeAddress(envelopeFrom);
        const remaining: string[] = (list.memberAddresses ?? []).filter((m) => normalizeAddress(m) !== normalizedFrom);

        try {
            await this.distributionListRepo!.update(
                { uid: list.uid, version: list.version, memberAddresses: remaining },
                list,
                { ignoreACL: true },
            );
        } catch (err: any) {
            this.logger?.warn(
                `MailIngestRoute: failed to remove unsubscribing member '${envelopeFrom}' from '${list.primarySmtpAddress}': ${err.message}`,
            );
            return;
        }

        try {
            const composed: Buffer = await new MailComposer({
                from: list.primarySmtpAddress,
                to: envelopeFrom,
                subject: `Unsubscribed from ${list.name}`,
                text: `You have been removed from ${list.name} (${list.primarySmtpAddress}) and will no longer receive messages sent to this list.`,
            })
                .compile()
                .build();
            await this.mailTransport!.send({ raw: composed, envelopeFrom: list.primarySmtpAddress, envelopeTo: [envelopeFrom] });
        } catch (err: any) {
            this.logger?.warn(`MailIngestRoute: failed to send unsubscribe confirmation to '${envelopeFrom}': ${err.message}`);
        }
    }

    /**
     * Evaluates every configured `TransportRule` once against the whole SMTP transaction (`envelopeFrom`, the
     * full `envelopeTo` list, and the raw message) - the one point in this codebase that has the complete
     * envelope in hand before per-recipient resolution/fan-out. Called once at the top of `deliver()`, before
     * anything is queued/relayed.
     *
     * Returns immediately (no parse attempted) when no *enabled* `TransportRule`s exist - zero overhead for a
     * deployment that doesn't use this feature, or has disabled all its rules. `enabled: true` is pushed into
     * the query itself rather than fetched-then-filtered, matching `evaluateTransportRules()`'s own filter -
     * see `MailFilterRule`'s identical `ScanQueueJob` fetch for the same convention. A matching `reject`
     * action sends a rejection notice to `envelopeFrom` (best-effort - a send failure is logged, not
     * propagated) and tells the caller to skip all
     * delivery; a matching `add_header`/`add_recipient` action is folded into the returned `raw`/`envelopeTo`
     * so the rest of `deliver()`'s existing per-recipient loop applies it uniformly (an added recipient is
     * resolved exactly like any other; an added header is present in every stored/relayed copy, including a
     * distribution-list-expanded one, since `rewriteHeadersForList()` is applied on top of this already-tagged
     * `raw`). A matching `quarantine` action is surfaced as `quarantineReason` for the caller to stamp onto
     * every `IngestQueueEntry` it creates for this transaction - see `ScanQueueJob.processEntry()`.
     */
    private async applyTransportRules(
        raw: Buffer,
        envelopeFrom: string,
        envelopeTo: string[],
    ): Promise<{ reject: boolean; raw: Buffer; envelopeTo: string[]; quarantineReason?: QuarantineReason }> {
        const rules: TransportRule[] = await this.transportRuleRepo!.find({ enabled: true }, { ignoreACL: true });
        if (rules.length === 0) {
            return { reject: false, raw, envelopeTo };
        }

        const domains: string[] = await getVerifiedDomainNames(this._objectFactory!, this.domainClass);
        const context = await buildTransportRuleContext(raw, envelopeFrom, envelopeTo, domains);
        const evaluation = evaluateTransportRules(rules, context);

        if (evaluation.reject) {
            try {
                // A null/empty envelope-from is the standard SMTP convention for a bounce/rejection notice
                // (prevents a bounce-loop if this notice itself were somehow rejected); `postmaster@<domain>`
                // is used only as the *display* From address, matching how a real MTA's own generated NDRs
                // present themselves.
                const composed: Buffer = await new MailComposer({
                    from: `Mail Delivery System <postmaster@${domains[0] ?? "localhost"}>`,
                    to: envelopeFrom,
                    subject: "Message Rejected",
                    text: "Your message could not be delivered because it was blocked by a mail-flow policy on the recipient's mail system.",
                })
                    .compile()
                    .build();
                await this.mailTransport!.send({ raw: composed, envelopeFrom: "", envelopeTo: [envelopeFrom] });
            } catch (err: any) {
                this.logger?.warn(`MailIngestRoute: failed to send transport-rule rejection notice to '${envelopeFrom}': ${err.message}`);
            }
            return { reject: true, raw, envelopeTo };
        }

        const effectiveRaw: Buffer = evaluation.addHeaders.length > 0 ? prependHeaders(raw, evaluation.addHeaders) : raw;
        const seen: Set<string> = new Set(envelopeTo.map((a) => normalizeAddress(a)));
        const effectiveEnvelopeTo: string[] = [...envelopeTo];
        for (const address of evaluation.addRecipients) {
            const normalized = normalizeAddress(address);
            if (!seen.has(normalized)) {
                seen.add(normalized);
                effectiveEnvelopeTo.push(address);
            }
        }

        return {
            reject: false,
            raw: effectiveRaw,
            envelopeTo: effectiveEnvelopeTo,
            quarantineReason: evaluation.quarantine ? QuarantineReason.TRANSPORT_RULE : undefined,
        };
    }

    @Summary("Resolve recipient")
    @Description(
        "Called by the MTA's recipient-validation hook before accepting a message. Responds 200 if a mailbox " +
            "or distribution list exists for the given address, 404 otherwise.",
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
        const address: string = normalizeAddress(rcpt);

        const [mailbox, list] = await Promise.all([
            this.findMailboxByAddress(address),
            this.findDistributionListByAddress(address),
        ]);

        return mailbox || list ? res.status(200) : res.status(404);
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
        const envelopeFromNormalized: string = normalizeAddress(envelopeFrom);
        const envelopeToHeader: string | undefined = firstHeader(req, "x-envelope-to");
        let envelopeTo: string[] = envelopeToHeader ? envelopeToHeader.split(",").map((a) => a.trim()) : [];
        let raw: Buffer | undefined = req.rawBody;

        if (!raw || raw.length === 0 || envelopeTo.length === 0) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }

        // Evaluated once for the whole transaction, before any per-recipient resolution/fan-out below - see
        // `applyTransportRules()`'s own doc comment for why this must happen here rather than per-recipient.
        const transportRuleOutcome = await this.applyTransportRules(raw, envelopeFrom, envelopeTo);
        if (transportRuleOutcome.reject) {
            const results = envelopeTo.map((rcpt) => ({ rcpt: normalizeAddress(rcpt), queued: false }));
            res.status(202).json({ results });
            return res;
        }
        raw = transportRuleOutcome.raw;
        envelopeTo = transportRuleOutcome.envelopeTo;
        const quarantineReason = transportRuleOutcome.quarantineReason;

        // A single SMTP transaction can carry more than one RCPT TO — resolve and stage one IngestQueueEntry
        // per addressed mailbox so `ScanQueueJob` delivers independently to each, and one unknown/unresolvable
        // recipient in the batch doesn't block delivery to the others.
        const results: { rcpt: string; queued: boolean }[] = [];
        for (const rcpt of envelopeTo) {
            const address: string = normalizeAddress(rcpt);
            const mailbox: M | undefined = await this.findMailboxByAddress(address);

            if (mailbox) {
                const rawBlobKey: string = `ingest/${crypto.randomUUID()}`;
                await this.blobStore.put(rawBlobKey, raw, { contentType: "message/rfc822" });
                await this.ingestQueueRepo!.create(
                    new this.ingestQueueClass({
                        mailboxUid: mailbox.uid,
                        envelopeFrom,
                        envelopeTo: [address],
                        rawBlobKey,
                        status: IngestStatus.PENDING,
                        quarantineReason,
                    }),
                    { ignoreACL: true },
                );
                results.push({ rcpt: address, queued: true });
                continue;
            }

            const list: DistributionList | undefined = await this.findDistributionListByAddress(address);
            if (!list) {
                this.logger?.warn(`MailIngestRoute: dropping delivery for unresolvable recipient '${address}'.`);
                results.push({ rcpt: address, queued: false });
                continue;
            }

            const isMember: boolean = (list.memberAddresses ?? []).some(
                (m) => normalizeAddress(m) === envelopeFromNormalized,
            );

            // A current member emailing the list itself with `Subject: unsubscribe` is removed from
            // `memberAddresses` instead of the message being fanned out - checked before `restrictSenders` so
            // unsubscribing works regardless of that flag.
            if (isMember && extractHeader(raw, "Subject")?.trim().toLowerCase() === "unsubscribe") {
                await this.handleUnsubscribe(list, envelopeFrom);
                results.push({ rcpt: address, queued: false });
                continue;
            }

            if (list.restrictSenders && !isMember) {
                this.logger?.warn(
                    `MailIngestRoute: dropping delivery to restricted list '${address}' from non-member sender '${envelopeFrom}'.`,
                );
                results.push({ rcpt: address, queued: false });
                continue;
            }

            const { mailboxes, externalAddresses } = await this.expandDistributionList(
                list,
                envelopeFromNormalized,
                new Set([list.uid]),
                0,
            );

            if (mailboxes.length === 0 && externalAddresses.length === 0) {
                results.push({ rcpt: address, queued: false });
                continue;
            }

            // One rewritten copy (Reply-To swapped to the list's own address, List-Id/List-Unsubscribe added),
            // shared by every internal member's `IngestQueueEntry` and every external relay - not rebuilt or
            // re-stored per recipient.
            const listRaw: Buffer = rewriteHeadersForList(raw, list);
            const rawBlobKey: string = `ingest/${crypto.randomUUID()}`;
            await this.blobStore.put(rawBlobKey, listRaw, { contentType: "message/rfc822" });

            for (const member of mailboxes) {
                await this.ingestQueueRepo!.create(
                    new this.ingestQueueClass({
                        mailboxUid: member.uid,
                        envelopeFrom,
                        envelopeTo: [address],
                        rawBlobKey,
                        status: IngestStatus.PENDING,
                        quarantineReason,
                    }),
                    { ignoreACL: true },
                );
            }

            for (const external of externalAddresses) {
                try {
                    await this.mailTransport!.send({
                        raw: listRaw,
                        envelopeFrom: list.primarySmtpAddress,
                        envelopeTo: [external],
                    });
                } catch (err: any) {
                    this.logger?.warn(
                        `MailIngestRoute: failed to relay distribution list message to external member '${external}': ${err.message}`,
                    );
                }
            }

            results.push({ rcpt: address, queued: mailboxes.length > 0 || externalAddresses.length > 0 });
        }

        res.status(202).json({ results });
        return res;
    }
}

function firstHeader(req: HttpRequest, name: string): string | undefined {
    const value: string | string[] | undefined = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
}
