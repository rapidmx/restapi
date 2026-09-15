///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The consuming application must apply `@Route("/mailbox")` to its own concrete subclass (see
// `BaseMailIngestRoute`'s identical note) - `@Get("/:id/keys/lookup")` below then resolves to
// `GET /mailbox/:id/keys/lookup`.
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import {
    ACLAction,
    ACLUtils,
    ApiErrorMessages,
    ApiErrors,
    type HttpRequest,
    ModelUtils,
    ObjectFactory,
    RepoUtils,
    RouteDecorators,
} from "@rapidrest/service-core";
import type { DnsResolver } from "../dns/DnsResolver.js";
import { AuditAction, Contact, Folder, Mailbox, PublicKey } from "../models/types.js";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { ContactKeyMerge, ContactKeyWriteResult, ContactKeyWriteTarget, writeContactKeys } from "../util/ContactKeyUtils.js";
import { discoverAndMergeKeys, KeyringUpdate } from "../util/KeyringUtils.js";
import { isPlainAddress } from "../util/MimeHeaderUtils.js";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
import { parseTrustedSignerKey } from "../util/SignerCertificateUtils.js";
const { Config, Inject, Logger } = ObjectDecorators;
const { Get, Param, Post, Query, RateLimit, Request, User: AuthUser } = RouteDecorators;

/** The wire shape `GET /mailbox/:id/keys/lookup` (and `POST /mailbox/:id/keys/trust`) returns. */
export type PublicKeyLookupResult = KeyringUpdate;

/** The body of `POST /mailbox/:id/keys/trust`. */
export interface TrustSignerRequest {
    /** The signer's address, one plain `local@domain`. */
    address: string;
    /** The signer's certificate, base64 DER X.509. */
    certificate: string;
}

/**
 * Implements `specs/end-to-end_encryption.md`'s "Discovery is Server-Side" requirement:
 * `GET /mailbox/:id/keys/lookup?addr=<addr>` performs the DNS lookup and remote endpoint fetch itself
 * (`util/KeyringUtils.ts`'s `discoverAndMergeKeys()`) rather than expecting the client to - browsers have no
 * DNS TXT API and would hit CORS fetching an arbitrary third-party domain directly.
 *
 * The result is persisted onto a `Contact` in the mailbox's own address book (creating one, in its
 * `CONTACTS` folder, if `addr` has never been seen before) - Key Conflict Handling and Anti-Downgrade are
 * `discoverAndMergeKeys()`'s job, not this route's; this route only decides what to do with the *result*
 * (create vs. update the `Contact`, what to return when nothing new could be discovered).
 *
 * `POST /mailbox/:id/keys/trust` lets the user pin a signer's certificate by hand ("Trust this signer") for an address
 * that has no signing key pinned yet - see `trust()`.
 *
 * Ordinary `ACLUtils.hasPermission()` (with its usual trusted-role bypass) is used here, deliberately unlike
 * `BaseKeyVaultRoute` - this endpoint only ever touches the mailbox's own address book, never private key
 * material, so there is no reason to exclude the standard bypass the way `KeyVault` access does.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseKeyLookupRoute<M extends Mailbox, C extends Contact, F extends Folder> {
    protected abstract mailboxClass: any;
    protected abstract contactClass: any;
    protected abstract folderClass: any;
    protected abstract auditLogClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private mailboxRepo?: RepoUtils<M>;
    private contactRepo?: RecoverableRepoUtils<C>;
    private folderRepo?: RecoverableRepoUtils<F>;

    @Inject(ACLUtils)
    private aclUtils?: ACLUtils;

    @Inject("DnsResolver")
    private dnsResolver?: DnsResolver;

    /** The whole application config, needed only to pass through to `recordAuditLog()` (`caller.config`). */
    @Config()
    private config: any;

    @Logger
    private logger: any;

    private async init(): Promise<void> {
        if (!this.mailboxRepo) {
            this.mailboxRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.mailboxClass.name,
                args: [this.mailboxClass],
            });
        }
        if (!this.contactRepo) {
            this.contactRepo = await this._objectFactory!.newInstance(RecoverableRepoUtils, {
                name: this.contactClass.name,
                args: [this.contactClass],
            });
        }
        if (!this.folderRepo) {
            this.folderRepo = await this._objectFactory!.newInstance(RecoverableRepoUtils, {
                name: this.folderClass.name,
                args: [this.folderClass],
            });
        }
    }

    /**
     * Builds the query fragment that matches a `Contact` whose `emails` array contains `address`. Mirrors
     * `ScanQueueJob.contactEmailQuery()`'s identical Mongo-native/SQL-`Raw()`-LIKE split exactly (see that
     * method's own doc comment for why) - MongoDB addresses an array element's own field with dot notation
     * natively; the SQL backend stores `emails` as a serialized `simple-json` column with no field-addressing
     * query possible at all, so `BaseKeyLookupRouteSQL` overrides this the same way `ScanQueueJobSQL` does. The address
     * is client input, so it's a `ModelUtils.literal()` (never parsed as an operator).
     */
    protected contactEmailQuery(address: string): any {
        return { "emails.address": ModelUtils.literal(address) };
    }

    private toPublic(contact: Pick<C, "keys" | "encryptPreference" | "keyConflict">): PublicKeyLookupResult {
        return { keys: contact.keys ?? [], encryptPreference: contact.encryptPreference, keyConflict: contact.keyConflict };
    }

    /** The mailbox `mailboxId` names, which `user` must be able to UPDATE (404 when missing, 403 without UPDATE). */
    private async requireUpdatableMailbox(mailboxId: string, user: JWTUser | undefined): Promise<M> {
        const mailbox: M | undefined = await this.mailboxRepo!.findOne(mailboxId, { ignoreACL: true });
        if (!mailbox) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        if (!(await this.aclUtils!.hasPermission(user, mailbox.uid, ACLAction.UPDATE))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
        return mailbox;
    }

    private async requirePermission(user: JWTUser | undefined, uid: string, action: string): Promise<void> {
        if (!(await this.aclUtils!.hasPermission(user, uid, action))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
    }

    /** Reads, merges and writes the key state of `address`'s contact in `mailbox` (`util/ContactKeyUtils.ts`). */
    private writeKeys(
        mailbox: M,
        address: string,
        user: JWTUser | undefined,
        merge: ContactKeyMerge<C>,
        beforeCreate?: (folder: F) => Promise<void>,
    ): Promise<ContactKeyWriteResult<C>> {
        const target: ContactKeyWriteTarget<C, F> = {
            contactRepo: this.contactRepo!,
            folderRepo: this.folderRepo!,
            contactClass: this.contactClass,
            folderClass: this.folderClass,
            mailboxUid: mailbox.uid,
            address,
            user,
            beforeCreate,
            findContact: async () =>
                (
                    await this.contactRepo!.find(
                        { mailboxUid: mailbox.uid, limit: 1, ...this.contactEmailQuery(address) },
                        { ignoreACL: true, limit: 1, skipCache: true },
                    )
                )[0],
        };
        return writeContactKeys(target, merge);
    }

    // This endpoint drives an outbound DNS lookup plus an HTTPS fetch to a remote, attacker-influenced host
    // on every cache-miss call (`util/KeyDiscoveryClient.ts`'s `fetchRemoteKeys()`) - unlike
    // `BaseKeyDiscoveryRoute`'s public endpoint (which already carries `@RateLimit()` for the same reason),
    // this one had none, making it an unthrottled request-amplification/SSRF-probing primitive for any
    // authenticated caller with `UPDATE` on a mailbox.
    @RateLimit()
    @Get("/:id/keys/lookup")
    public async lookup(
        @Param("id") mailboxId: string,
        @Query("addr") addr: string | undefined,
        @AuthUser user?: JWTUser,
    ): Promise<PublicKeyLookupResult> {
        await this.init();

        if (!addr) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The 'addr' query parameter is required.");
        }
        const mailbox: M = await this.requireUpdatableMailbox(mailboxId, user);

        // Version-checked update of an existing contact, or a create at a deterministic uid, re-merged after a lost race
        // (`writeContactKeys()`), so a concurrent lookup, inbound key header or trust can't leave two contacts.
        const { contact } = await this.writeKeys(
            mailbox,
            addr,
            user,
            async (existing) => (await discoverAndMergeKeys(this.dnsResolver!, addr, existing)) as Partial<C> | undefined,
        );
        if (!contact) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, "No keys could be discovered for this address.");
        }
        return this.toPublic(contact);
    }

    /**
     * `POST /mailbox/:id/keys/trust` with `{ address, certificate }`: pins `certificate` (base64 DER X.509) as the signing
     * key of `address`'s contact in this mailbox - the "Trust this signer" action for a validly signed message whose
     * sender has no signing key pinned. Returns the same shape as `lookup()` for that address.
     *
     * Only ever adds the first signing key. A contact that already pins a signing key gets 409 when it's a different
     * certificate (replacing a pinned key stays with discovery's Key Conflict Handling, so this can't be used to substitute
     * a key) and 200 with nothing written when it's the same one. Existing encrypt keys, `encryptPreference` and
     * `keyConflict` are left alone; `keysFirstSeen` is set when unset.
     *
     * The certificate is validated by `util/SignerCertificateUtils.ts`'s `parseTrustedSignerKey()` (400: unparseable, not
     * currently valid, doesn't name `address`, not usable for signing mail); fingerprint and validity dates come from the
     * certificate itself, never the client.
     *
     * Authorization: UPDATE on the mailbox (as `lookup()`; 404 for a missing mailbox, 403 otherwise), plus what the
     * contact write routes (`BaseContactRoute`) require for the write itself - UPDATE on the existing contact's folder, or
     * CREATE on the mailbox's Contacts folder when a contact is created. A delegate is authorized by the same ACLs (a
     * `manager` has both through the mailbox ACL; a `viewer` has neither), and a trusted role bypasses them as usual.
     *
     * Writes go through `writeContactKeys()` (version-checked update, deterministic-uid create, re-merge after a lost race),
     * so two concurrent trusts, or a trust racing discovery or an inbound key header, end with one signing key. An
     * `AuditAction.CONTACT_KEY_TRUSTED` entry records the mailbox, address and fingerprint of each key pinned.
     */
    @RateLimit()
    @Post("/:id/keys/trust")
    public async trust(
        @Param("id") mailboxId: string,
        body: TrustSignerRequest,
        @Request req?: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<PublicKeyLookupResult> {
        await this.init();

        if (!body || typeof body !== "object" || Array.isArray(body)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The request body must be an object with 'address' and 'certificate'.");
        }
        const { address, certificate } = body as Partial<TrustSignerRequest>;
        if (!isPlainAddress(address)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'address' must be a single plain email address.");
        }
        const mailbox: M = await this.requireUpdatableMailbox(mailboxId, user);
        const key: PublicKey = parseTrustedSignerKey(certificate, address);

        const now: number = Date.now();
        const { contact, written } = await this.writeKeys(
            mailbox,
            address,
            user,
            async (existing) => {
                if (existing) {
                    await this.requirePermission(user, existing.folderUid, ACLAction.UPDATE);
                }
                const pinned: PublicKey | undefined = existing?.keys?.find((k) => k.useType === "sign");
                if (pinned) {
                    if (pinned.fingerprint === key.fingerprint) {
                        return undefined;
                    }
                    throw new ApiError(
                        ApiErrors.IDENTIFIER_EXISTS,
                        409,
                        "A different signing key is already pinned for this address. It can't be replaced from here.",
                    );
                }
                return { keys: [...(existing?.keys ?? []), key], keysFirstSeen: existing?.keysFirstSeen ?? now } as Partial<C>;
            },
            (folder) => this.requirePermission(user, folder.uid, ACLAction.CREATE),
        );

        if (written) {
            await recordAuditLog(
                this._objectFactory!,
                this.auditLogClass,
                { config: this.config, req, user, logger: this.logger },
                {
                    action: AuditAction.CONTACT_KEY_TRUSTED,
                    targetType: "Contact",
                    targetUid: contact!.uid,
                    mailboxUid: mailbox.uid,
                    details: { address, fingerprint: key.fingerprint },
                },
            );
        }
        return this.toPublic(contact!);
    }
}
