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
import { sendOrThrow } from "../transport/TransportResultUtils.js";
import { DistributionList, IngestQueueEntry, IngestStatus, Mailbox, QuarantineReason, TransportRule } from "../models/types.js";
import { normalizeAddress, stripPlusTag } from "../util/AddressUtils.js";
import { rewriteHeadersForList } from "../util/DistributionListUtils.js";
import { getVerifiedDomainNames } from "../util/DomainUtils.js";
import { extractHeader, prepareRelayCopy, prependHeaders, verifiedFromAddress } from "../util/MimeHeaderUtils.js";
import { asEntity } from "../util/EntityUtils.js";
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
 * **Deployment requirement (RFC 8601 §5):** the MTA MUST delete any `Authentication-Results` header already
 * present on a message (which a remote sender can forge with arbitrary content, including a fabricated
 * `dkim=pass`) before adding its own verified result, and MUST stamp its own with the exact `authserv-id`
 * configured at `mail:security:trusted_authserv_id`. `ScanQueueJob`'s inbound `RapidMX-Key`/receipt processing
 * (`util/AuthenticationResultsUtils.ts`'s `hasAlignedPassingDkim()`) trusts only an `Authentication-Results`
 * entry whose `authserv-id` matches that configured value; an MTA that fails to strip a forged pre-existing
 * instance of the header defeats that gate entirely, since this application has no way to tell a forged
 * instance from the MTA's own genuine one once both are present on the same message.
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
 * A list with `restrictSenders` only accepts a message whose `From` is DKIM-verified (`verifiedFromAddress()`) and names
 * a member. The copy relayed to external members goes through `prepareRelayCopy()` (see `deliver()`), so the MTA's
 * signature on it can't launder a spoofed `From`, recall/key headers or an iTIP request.
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

    /** Gmail-style `user+tag@domain.com` plus-addressing - see `findMailboxByAddress()`. Mailbox-scoped only
     * (not `DistributionList`) and delivery-routing only (not authentication/login) - deliberate scope
     * boundaries, not oversights. */
    /** The `authserv-id` of the MTA's own `Authentication-Results` header - see this class's doc comment. An unsubscribe
     * is only honored with aligned, passing DKIM reported under it; unset (`""`), no unsubscribe is honored. */
    @Config("mail:security:trusted_authserv_id", "")
    private trustedAuthservId: string = "";

    @Config("mail:plus_addressing:enabled", true)
    private plusAddressingEnabled: boolean = true;

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

    /** An exact `primarySmtpAddress`/`aliasAddresses` match for `address`, with no plus-tag fallback. Split out
     * from `findMailboxByAddress()` so callers that must not let the plus-tag fallback tier shadow an exact
     * `DistributionList` match (`deliver()`, `expandDistributionList()`) can check this tier, then a
     * `DistributionList`, before ever falling back to a plus-stripped mailbox match. */
    private async findExactMailboxByAddress(address: string): Promise<M | undefined> {
        const mailboxes: M[] = await this.mailboxRepo!.find({ primarySmtpAddress: address }, { ignoreACL: true, limit: 1 });
        return (
            mailboxes[0] ??
            (await this.mailboxRepo!.find({ aliasAddresses: this.aliasQueryValue(address) }, { ignoreACL: true, limit: 1 }))[0]
        );
    }

    /** Only the plus-tag fallback tier of `findMailboxByAddress()` - an exact match against the plus-stripped
     * base address (`stripPlusTag()`, `util/AddressUtils.ts`), tried only if `address`'s local part has a `+`
     * and plus-addressing is enabled. Kept separate from `findExactMailboxByAddress()` so a caller that already
     * knows the exact tier missed doesn't need to needlessly re-query it. */
    private async findPlusStrippedMailbox(address: string): Promise<M | undefined> {
        const baseAddress: string = stripPlusTag(address);
        if (!this.plusAddressingEnabled || baseAddress === address) {
            return undefined;
        }
        return await this.findExactMailboxByAddress(baseAddress);
    }

    /**
     * Resolves `address` to a `Mailbox`, tried in three tiers: an exact `primarySmtpAddress` match, then an
     * exact `aliasAddresses` match, then - only if `address`'s local part has a `+` and plus-addressing is
     * enabled - the same two exact-match tiers again against the plus-stripped base address
     * (`stripPlusTag()`, `util/AddressUtils.ts`). Retrying both tiers (not just `primarySmtpAddress`) means
     * `alias+tag@domain.com` also resolves through an existing `aliasAddresses` entry, not just a mailbox's
     * own primary address. Exact matches always win first, so a mailbox that has explicitly registered a
     * literal `+`-containing address (unusual, but not disallowed) still resolves to itself directly rather
     * than being reinterpreted as a plus-tagged variant of some other mailbox.
     *
     * Callers that also resolve `DistributionList` addresses (`deliver()`, `expandDistributionList()`'s member
     * loop) must NOT call this method directly - it would let the plus-tag fallback tier shadow an exact
     * `DistributionList` match (e.g. a list at `sales+urgent@domain.com` being misdelivered to a mailbox
     * `sales@domain.com` instead). Those callers use `findExactMailboxByAddress()`/`findPlusStrippedMailbox()`
     * directly, with an exact `DistributionList` check interleaved between the two tiers. `resolve()` has no
     * such ordering concern (either type resolving is equally a 200, never a delivery choice) and still calls
     * this method directly.
     */
    private async findMailboxByAddress(address: string): Promise<M | undefined> {
        return (await this.findExactMailboxByAddress(address)) ?? (await this.findPlusStrippedMailbox(address));
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
        verifiedSender: string | undefined,
        visitedListUids: Set<string>,
        depth: number,
    ): Promise<{ mailboxes: M[]; externalAddresses: string[] }> {
        if (depth > this.maxListDepth) {
            this.logger?.warn(`MailIngestRoute: distribution list expansion exceeded max depth at '${list.primarySmtpAddress}'.`);
            return { mailboxes: [], externalAddresses: [] };
        }
        if (list.restrictSenders && !this.isListMember(list, verifiedSender)) {
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

            // Exact mailbox match, then exact `DistributionList` match, THEN the plus-tag fallback - in that
            // order - so a nested list whose own address happens to contain a `+` can never be shadowed by an
            // unrelated mailbox's plus-stripped base address (see `findMailboxByAddress()`'s own doc comment).
            let mailbox: M | undefined = await this.findExactMailboxByAddress(member);
            let nestedList: DistributionList | undefined;
            if (!mailbox) {
                nestedList = await this.findDistributionListByAddress(member);
            }
            if (!mailbox && !nestedList) {
                mailbox = await this.findPlusStrippedMailbox(member);
            }

            if (mailbox) {
                if (!seenMailboxUids.has(mailbox.uid)) {
                    seenMailboxUids.add(mailbox.uid);
                    mailboxes.push(mailbox);
                }
                continue;
            }

            if (nestedList) {
                if (visitedListUids.has(nestedList.uid)) {
                    this.logger?.warn(`MailIngestRoute: skipping distribution list cycle at '${nestedList.primarySmtpAddress}'.`);
                    continue;
                }
                visitedListUids.add(nestedList.uid);
                const nested = await this.expandDistributionList(nestedList, verifiedSender, visitedListUids, depth + 1);
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
    /**
     * Whether `raw` provably comes from `member`: its one `From` header is exactly `member`, and the trusted MTA
     * (`mail:security:trusted_authserv_id`) reported a passing DKIM signature aligned with the member's domain.
     */
    private isVerifiedMemberMessage(raw: Buffer, member: string): boolean {
        return verifiedFromAddress(raw, this.trustedAuthservId) === normalizeAddress(member);
    }

    /** Whether `sender` - the message's DKIM-verified `From` (`verifiedFromAddress()`), never the forgeable envelope
     * sender - is one of `list`'s members. `restrictSenders` lets only such messages through. */
    private isListMember(list: DistributionList, sender: string | undefined): boolean {
        return !!sender && (list.memberAddresses ?? []).some((m) => normalizeAddress(m) === sender);
    }

    private async handleUnsubscribe(list: DistributionList, envelopeFrom: string): Promise<void> {
        const normalizedFrom: string = normalizeAddress(envelopeFrom);

        try {
            // `list` is a `find()` row - a plain document on Mongo, which `update()` writes back unversioned (`asEntity()`),
            // so a concurrent membership change could be silently undone. A conflict re-reads the list and retries.
            let current: DistributionList | undefined = list;
            for (let attempt = 1; current; attempt++) {
                // `deliver()` only unsubscribes a member it found in this list, so there is a member list.
                const members: string[] = current.memberAddresses;
                const remaining: string[] = members.filter((m) => normalizeAddress(m) !== normalizedFrom);
                /* v8 ignore next 3 -- only when a concurrent unsubscribe already removed the member */
                if (remaining.length === members.length) {
                    break;
                }
                try {
                    await this.distributionListRepo!.update(
                        { uid: current.uid, version: current.version, memberAddresses: remaining },
                        asEntity(this.distributionListRepo!, current),
                        { ignoreACL: true },
                    );
                    break;
                    /* v8 ignore start -- only a concurrent change to the same list reaches here */
                } catch (err: any) {
                    if (attempt >= 3 || err?.status !== 409) {
                        throw err;
                    }
                    current = await this.distributionListRepo!.findOne(list.uid, { ignoreACL: true, skipCache: true });
                }
                /* v8 ignore stop */
            }
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
            await sendOrThrow(this.mailTransport!, { raw: composed, envelopeFrom: list.primarySmtpAddress, envelopeTo: [envelopeFrom] });
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
        const context = await buildTransportRuleContext(raw, envelopeFrom, envelopeTo, domains, this.plusAddressingEnabled);
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
                await sendOrThrow(this.mailTransport!, { raw: composed, envelopeFrom: "", envelopeTo: [envelopeFrom] });
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

    @Summary("Check relay domain")
    @Description(
        "Called by the MTA's relay-domain lookup (e.g. Postfix `relay_domains`) to decide whether it should " +
            "accept/relay mail for a given domain at all, before ever checking an individual recipient. " +
            "Responds 200 if the domain is a currently enabled-and-verified `Domain`, 404 otherwise.",
    )
    @Get("/domain")
    public async domain(
        @Query("name") name: string,
        @Request req: HttpRequest,
        @Response res: HttpResponse,
    ): Promise<HttpResponse> {
        this.authorizeInternalCaller(req);
        await this.init();

        if (!name) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }

        const domains: string[] = await getVerifiedDomainNames(this._objectFactory!, this.domainClass);
        return domains.includes(name.toLowerCase()) ? res.status(200) : res.status(404);
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
        // The message's DKIM-verified `From`, if any - what `restrictSenders` checks list membership against.
        const verifiedSender: string | undefined = verifiedFromAddress(raw, this.trustedAuthservId);

        // A single SMTP transaction can carry more than one RCPT TO — resolve and stage one IngestQueueEntry
        // per addressed mailbox so `ScanQueueJob` delivers independently to each, and one unknown/unresolvable
        // recipient in the batch doesn't block delivery to the others.
        const results: { rcpt: string; queued: boolean }[] = [];
        // Every direct-mailbox recipient below shares this exact same `raw` (it's never rewritten per-
        // recipient, unlike the distribution-list branch's `listRaw`) - written to the blob store at most once
        // per `deliver()` call and reused, the same one-copy-shared-by-every-recipient pattern the
        // distribution-list branch below already uses for `listRaw`/`rawBlobKey`. Previously minted a fresh
        // blob (a full copy of `raw`) per direct recipient - e.g. a 20MB attachment CC'd to 50 internal
        // mailboxes wrote ~1GB for one logical message instead of one 20MB blob.
        let directRawBlobKey: string | undefined;
        for (const rcpt of envelopeTo) {
            const address: string = normalizeAddress(rcpt);
            // Exact mailbox match, then exact `DistributionList` match, THEN the plus-tag fallback - in that
            // order - so a list whose own address happens to contain a `+` can never be shadowed by an
            // unrelated mailbox's plus-stripped base address (see `findMailboxByAddress()`'s own doc comment).
            let mailbox: M | undefined = await this.findExactMailboxByAddress(address);
            let list: DistributionList | undefined;
            if (!mailbox) {
                list = await this.findDistributionListByAddress(address);
            }
            if (!mailbox && !list) {
                mailbox = await this.findPlusStrippedMailbox(address);
            }

            if (mailbox) {
                if (!directRawBlobKey) {
                    directRawBlobKey = `ingest/${crypto.randomUUID()}`;
                    await this.blobStore.put(directRawBlobKey, raw, { contentType: "message/rfc822" });
                }
                await this.ingestQueueRepo!.create(
                    new this.ingestQueueClass({
                        mailboxUid: mailbox.uid,
                        envelopeFrom,
                        envelopeTo: [address],
                        rawBlobKey: directRawBlobKey,
                        status: IngestStatus.PENDING,
                        quarantineReason,
                    }),
                    { ignoreACL: true },
                );
                results.push({ rcpt: address, queued: true });
                continue;
            }

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
            // unsubscribing works regardless of that flag. The envelope sender is forgeable, so the removal needs proof
            // the member sent it (`isVerifiedMemberMessage()`); an unverifiable request is dropped, not fanned out.
            if (isMember && extractHeader(raw, "Subject")?.trim().toLowerCase() === "unsubscribe") {
                if (this.isVerifiedMemberMessage(raw, envelopeFromNormalized)) {
                    await this.handleUnsubscribe(list, envelopeFrom);
                } else {
                    this.logger?.warn(
                        `MailIngestRoute: ignoring unverified unsubscribe for '${envelopeFrom}' from '${list.primarySmtpAddress}'.`,
                    );
                }
                results.push({ rcpt: address, queued: false });
                continue;
            }

            // `restrictSenders` needs proof the sender is a member: a DKIM-verified `From` naming one. The envelope sender
            // (and an unauthenticated `From`) can be forged by anyone.
            if (list.restrictSenders && !this.isListMember(list, verifiedSender)) {
                this.logger?.warn(
                    `MailIngestRoute: dropping delivery to restricted list '${address}' from a sender not verified as a member ('${envelopeFrom}').`,
                );
                results.push({ rcpt: address, queued: false });
                continue;
            }

            const { mailboxes, externalAddresses } = await this.expandDistributionList(list, verifiedSender, new Set([list.uid]), 0);

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

            // External members get a copy the MTA signs as this server's domain, so it must not launder a spoofed message
            // (`prepareRelayCopy()`): trust-bearing headers stripped, an unauthenticated `From` rewritten to the list, and
            // unauthenticated calendar content not relayed at all. Internal members keep `listRaw` - their copies are
            // judged by `ScanQueueJob` against the `Authentication-Results` this server's MTA stamped on arrival.
            const externalRaw: Buffer | undefined =
                externalAddresses.length > 0
                    ? prepareRelayCopy(listRaw, { trustedAuthservId: this.trustedAuthservId, rewriteFrom: { address: list.primarySmtpAddress, name: list.name } })
                    : undefined;
            if (externalAddresses.length > 0 && !externalRaw) {
                this.logger?.warn(
                    `MailIngestRoute: not relaying calendar content from an unauthenticated sender to the external members of '${list.primarySmtpAddress}'.`,
                );
            }

            for (const external of externalRaw ? externalAddresses : []) {
                try {
                    // Throws on a transport rejection too, so a relay that reached nobody is logged like an error.
                    await sendOrThrow(this.mailTransport!, {
                        raw: externalRaw!,
                        envelopeFrom: list.primarySmtpAddress,
                        envelopeTo: [external],
                    });
                } catch (err: any) {
                    this.logger?.warn(
                        `MailIngestRoute: failed to relay distribution list message to external member '${external}': ${err.message}`,
                    );
                }
            }

            results.push({ rcpt: address, queued: mailboxes.length > 0 || (!!externalRaw && externalAddresses.length > 0) });
        }

        res.status(202).json({ results });
        return res;
    }
}

function firstHeader(req: HttpRequest, name: string): string | undefined {
    const value: string | string[] | undefined = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
}
