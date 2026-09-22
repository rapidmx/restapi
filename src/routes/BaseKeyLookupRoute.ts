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
import { AuditAction, Contact, EncryptionPreference, Folder, KeyConflict, Mailbox, PreviousKey, PublicKey } from "../models/types.js";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { ContactKeyMerge, ContactKeyWriteResult, ContactKeyWriteTarget, writeContactKeys } from "../util/ContactKeyUtils.js";
import { getVerifiedDomainNames, resolveDomainAlias } from "../util/DomainUtils.js";
import { hasMailAccess } from "../util/MailAccessUtils.js";
import { addPreviousKey, addRejectedKey, discoverAndMergeKeys, listField, normalizeKeyConflicts, withoutKey } from "../util/KeyringUtils.js";
import { LocalKeyDiscovery } from "../util/LocalKeyDiscoveryUtils.js";
import { isPlainAddress } from "../util/MimeHeaderUtils.js";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
import { parseContactKey, parseTrustedSignerKey } from "../util/SignerCertificateUtils.js";
const { Config, Inject, Logger } = ObjectDecorators;
const { Get, Param, Post, Query, RateLimit, Request, User: AuthUser } = RouteDecorators;

/** The wire shape `GET /mailbox/:id/keys/lookup`, `POST /mailbox/:id/keys/trust` and `POST /mailbox/:id/keys/resolve`
 * return. `keyConflicts` and `previousKeys` are omitted when empty. */
export interface PublicKeyLookupResult {
    keys: PublicKey[];
    encryptPreference?: EncryptionPreference;
    keyConflicts?: KeyConflict[];
    previousKeys?: PreviousKey[];
}

/** The body of `POST /mailbox/:id/keys/trust`. */
export interface TrustSignerRequest {
    /** The signer's address, one plain `local@domain`. */
    address: string;
    /** The signer's certificate, base64 DER X.509. */
    certificate: string;
}

/** The body of `POST /mailbox/:id/keys/resolve`. */
export interface ResolveKeyConflictRequest {
    /** The contact's address, one plain `local@domain`. */
    address: string;
    /** Which of the contact's pinned keys the decision is about. */
    useType: "sign" | "encrypt";
    /** `"accept"` replaces the pinned key, `"reject"` dismisses the conflict. */
    action: "accept" | "reject";
    /** The fingerprint of the pinned key the user saw; the request is refused with 409 when it's no longer pinned. */
    expectedPinnedFingerprint: string;
    /** For `"accept"` only: the new key's certificate, base64 DER X.509. Defaults to the recorded conflict's key. */
    certificate?: string;
}

/** The longest `expectedPinnedFingerprint` accepted (a SHA-256 hex fingerprint is 64 characters). */
const MAX_FINGERPRINT_LENGTH = 256;

function pinnedKeyChanged(): ApiError {
    return new ApiError(
        ApiErrors.INVALID_OBJECT_VERSION,
        409,
        "The pinned key for this address is no longer the one expected. Review the current key and try again.",
    );
}

/** A conflict's observed key, validated as a key of its `useType` for `address` at `now` (400 when it no longer is),
 * keeping the `issuerCertificate` it was published with. */
function revalidatedConflictKey(conflict: KeyConflict, address: string, now: number): PublicKey {
    const key: PublicKey = parseContactKey(conflict.observedKey.publicKey, address, conflict.useType, now);
    return conflict.observedKey.issuerCertificate ? { ...key, issuerCertificate: conflict.observedKey.issuerCertificate } : key;
}

/**
 * Implements `specs/end-to-end_encryption.md`'s "Discovery is Server-Side" requirement:
 * `GET /mailbox/:id/keys/lookup?addr=<addr>` performs the DNS lookup and remote endpoint fetch itself
 * (`util/KeyringUtils.ts`'s `discoverAndMergeKeys()`) rather than expecting the client to - browsers have no
 * DNS TXT API and would hit CORS fetching an arbitrary third-party domain directly.
 *
 * An `addr` that lives on THIS deployment (a mailbox's primary address or alias, plus-tags resolved as delivery does, or
 * an address of one of this deployment's own domains) is answered from the local mailbox before any DNS or HTTP: the same
 * `KeyDiscoveryResponse` the public endpoint serves (`util/LocalKeyDiscoveryUtils.ts`), merged the same way. A local
 * address no mailbox has answers 404; a mailbox that published nothing answers 200 with `keys: []`, as a remote peer does.
 *
 * The result is persisted onto a `Contact` in the mailbox's own address book (creating one, in its
 * `CONTACTS` folder, if `addr` has never been seen before) - Key Conflict Handling and Anti-Downgrade are
 * `discoverAndMergeKeys()`'s job, not this route's; this route only decides what to do with the *result*
 * (create vs. update the `Contact`, what to return when nothing new could be discovered).
 *
 * `POST /mailbox/:id/keys/trust` lets the user pin a signer's certificate by hand ("Trust this signer") for an address
 * that has no signing key pinned yet - see `trust()`. `POST /mailbox/:id/keys/resolve` accepts or rejects a changed key
 * (`Contact.keyConflicts`) - see `resolve()`.
 *
 * Access is by ownership or an explicit ACL record (`hasMailAccess()`, `util/MailAccessUtils.ts`) - a trusted role
 * grants nothing, since a mailbox's address book (and the keys pinned in it) is the owner's personal data.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseKeyLookupRoute<M extends Mailbox, C extends Contact, F extends Folder> {
    protected abstract mailboxClass: any;
    protected abstract contactClass: any;
    protected abstract folderClass: any;
    protected abstract auditLogClass: any;
    protected abstract keyVaultClass: any;
    protected abstract domainClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private mailboxRepo?: RepoUtils<M>;
    private keyVaultRepo?: RepoUtils<any>;
    private contactRepo?: RecoverableRepoUtils<C>;
    private folderRepo?: RecoverableRepoUtils<F>;

    @Inject(ACLUtils)
    private aclUtils?: ACLUtils;

    @Config("trusted_roles", ["admin"])
    private trustedRoles: string[] = ["admin"];

    /** Gmail-style `user+tag@domain` plus-addressing - a recipient typed that way is looked up as `user@domain`, the mailbox
     * mail to it is delivered to (`BaseMailIngestRoute`). */
    @Config("mail:plus_addressing:enabled", true)
    private plusAddressingEnabled: boolean = true;

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
        if (!this.keyVaultRepo) {
            this.keyVaultRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.keyVaultClass.name,
                args: [this.keyVaultClass],
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

    /**
     * The query value matching one element of `Mailbox.aliasAddresses` - a literal on MongoDB (implicit array-element
     * equality). `KeyLookupRouteSQL` overrides it: the SQL backend stores the array as a serialized `simple-json` column, see
     * `BaseMailIngestRoute.aliasQueryValue()`, which this mirrors exactly.
     */
    protected aliasQueryValue(address: string): any {
        return ModelUtils.literal(address);
    }

    /** How `discoverAndMergeKeys()` reaches this deployment's own mailboxes, so a recipient that lives here is never sent
     * out to DNS and HTTP (`util/LocalKeyDiscoveryUtils.ts`). */
    private localKeyDiscovery(): LocalKeyDiscovery {
        return {
            mailboxRepo: this.mailboxRepo!,
            keyVaultRepo: this.keyVaultRepo!,
            domainNames: () => getVerifiedDomainNames(this._objectFactory!, this.domainClass),
            aliasQueryValue: (address) => this.aliasQueryValue(address),
            resolveDomainAlias: (address) => resolveDomainAlias(this._objectFactory!, this.domainClass, address),
            plusAddressing: this.plusAddressingEnabled,
        };
    }

    private toPublic(contact: C): PublicKeyLookupResult {
        const keyConflicts: KeyConflict[] = normalizeKeyConflicts(contact.keyConflicts);
        return {
            keys: contact.keys ?? [],
            encryptPreference: contact.encryptPreference,
            keyConflicts: keyConflicts.length > 0 ? keyConflicts : undefined,
            previousKeys: contact.previousKeys?.length ? contact.previousKeys : undefined,
        };
    }

    /** The mailbox `mailboxId` names, which `user` must be able to UPDATE - 403 when it doesn't exist too, so the answer
     * doesn't reveal which addresses have a mailbox. */
    private async requireUpdatableMailbox(mailboxId: string, user: JWTUser | undefined): Promise<M> {
        const mailbox: M | undefined = await this.mailboxRepo!.findOne(mailboxId, { ignoreACL: true });
        if (!mailbox || !(await hasMailAccess(this.aclUtils, this.trustedRoles, user, mailbox.uid, ACLAction.UPDATE))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
        return mailbox;
    }

    private async requirePermission(user: JWTUser | undefined, uid: string, action: string): Promise<void> {
        if (!(await hasMailAccess(this.aclUtils, this.trustedRoles, user, uid, action))) {
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

    // For an address that isn't local, this endpoint drives an outbound DNS lookup plus an HTTPS fetch to a remote,
    // attacker-influenced host on every cache-miss call (`util/KeyDiscoveryClient.ts`'s `fetchRemoteKeys()`) - unlike
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
            async (existing) => (await discoverAndMergeKeys(this.dnsResolver!, addr, existing, Date.now(), this.localKeyDiscovery())) as Partial<C> | undefined,
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
     * certificate (replacing a pinned key is `resolve()`'s job, which needs the pinned fingerprint the user saw, so this
     * can't be used to substitute a key) and 200 with nothing written when it's the same one. Existing encrypt keys, `encryptPreference` and
     * `keyConflicts` are left alone; `keysFirstSeen` is set when unset.
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

    /**
     * `POST /mailbox/:id/keys/resolve` with `{ address, useType, action, expectedPinnedFingerprint, certificate? }`: the
     * user's explicit decision on a changed key (`specs/end-to-end_encryption.md`'s Key Conflict Handling, step 4).
     * Returns the same shape as `lookup()` for that address.
     *
     * `accept` replaces the pinned `useType` key of `address`'s contact. The new key is `certificate` when given, else the
     * key recorded in that `useType`'s conflict; either way it's validated by `parseContactKey()` at the time of the
     * request (400: unparseable, not currently valid, doesn't name `address`, usage doesn't fit `useType`). Then:
     * - 404 when there's no contact, no pinned `useType` key, or (without `certificate`) no conflict for `useType`;
     * - 200 with nothing written when the given certificate is already the pinned key (checked before the fingerprint
     * match, so a retried accept of the same certificate succeeds);
     * - 409 when the pinned key isn't `expectedPinnedFingerprint` (it changed since the user looked);
     * - otherwise the new key is pinned, the old one moves to `previousKeys` (`replacement: "user"`), the `useType`'s
     * conflict is cleared, the new fingerprint leaves `previousKeys` and `rejectedKeys`, and
     * `AuditAction.CONTACT_KEY_REPLACED` is recorded with `{ address, useType, from, to }`.
     *
     * `reject` dismisses the `useType`'s conflict: 404 without a contact or conflict, 409 when the pinned key isn't
     * `expectedPinnedFingerprint`; otherwise the conflict is cleared, its fingerprint is added to `rejectedKeys` (so the
     * same key isn't recorded as a conflict again), and `AuditAction.CONTACT_KEY_CONFLICT_REJECTED` is recorded with
     * `{ address, useType, fingerprint, pinnedFingerprint }`. `certificate` is refused (400) with `reject`.
     *
     * Authorization is `trust()`'s: UPDATE on the mailbox (404 missing, 403 otherwise) and UPDATE on the contact's folder.
     * No contact is ever created. Writes go through `writeContactKeys()`, so a resolve racing discovery, an inbound key
     * header or another resolve is re-checked against the re-read contact (typically ending in 409 when the pinned key
     * moved underneath it).
     */
    @RateLimit()
    @Post("/:id/keys/resolve")
    public async resolve(
        @Param("id") mailboxId: string,
        body: ResolveKeyConflictRequest,
        @Request req?: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<PublicKeyLookupResult> {
        await this.init();

        if (!body || typeof body !== "object" || Array.isArray(body)) {
            throw new ApiError(
                ApiErrors.INVALID_REQUEST,
                400,
                "The request body must be an object with 'address', 'useType', 'action' and 'expectedPinnedFingerprint'.",
            );
        }
        const { address, useType, action, expectedPinnedFingerprint, certificate } = body as Partial<ResolveKeyConflictRequest>;
        if (!isPlainAddress(address)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'address' must be a single plain email address.");
        }
        if (useType !== "sign" && useType !== "encrypt") {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'useType' must be 'sign' or 'encrypt'.");
        }
        if (action !== "accept" && action !== "reject") {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'action' must be 'accept' or 'reject'.");
        }
        if (
            typeof expectedPinnedFingerprint !== "string" ||
            expectedPinnedFingerprint.length === 0 ||
            expectedPinnedFingerprint.length > MAX_FINGERPRINT_LENGTH
        ) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'expectedPinnedFingerprint' must be the fingerprint of the pinned key.");
        }
        if (certificate !== undefined && action === "reject") {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'certificate' can only be given with 'accept'.");
        }
        const mailbox: M = await this.requireUpdatableMailbox(mailboxId, user);
        const now: number = Date.now();
        const givenKey: PublicKey | undefined = certificate === undefined ? undefined : parseContactKey(certificate, address, useType, now);

        let audit: { action: AuditAction; details: Record<string, string> } | undefined;
        const { contact } = await this.writeKeys(mailbox, address, user, async (existing) => {
            audit = undefined;
            if (!existing) {
                throw new ApiError(ApiErrors.NOT_FOUND, 404, "There is no contact for this address.");
            }
            await this.requirePermission(user, existing.folderUid, ACLAction.UPDATE);
            const keys: PublicKey[] = [...(existing.keys ?? [])];
            const pinnedIndex: number = keys.findIndex((k) => k.useType === useType);
            const pinned: PublicKey | undefined = keys[pinnedIndex];
            const conflicts: KeyConflict[] = normalizeKeyConflicts(existing.keyConflicts);
            const conflict: KeyConflict | undefined = conflicts.find((c) => c.useType === useType);
            const remainingConflicts = listField(
                conflicts.filter((c) => c.useType !== useType),
                existing.keyConflicts,
            );

            if (action === "reject") {
                if (!conflict) {
                    throw new ApiError(ApiErrors.NOT_FOUND, 404, "There is no key conflict to reject for this address.");
                }
                if (pinned?.fingerprint !== expectedPinnedFingerprint) {
                    throw pinnedKeyChanged();
                }
                const fingerprint: string = conflict.observedKey.fingerprint;
                audit = {
                    action: AuditAction.CONTACT_KEY_CONFLICT_REJECTED,
                    details: { address, useType, fingerprint, pinnedFingerprint: pinned.fingerprint },
                };
                return {
                    keyConflicts: remainingConflicts,
                    rejectedKeys: addRejectedKey(existing.rejectedKeys, { useType, fingerprint, rejectedAt: now }),
                } as Partial<C>;
            }

            if (!pinned) {
                throw new ApiError(ApiErrors.NOT_FOUND, 404, "There is no pinned key of this type to replace for this address.");
            }
            if (givenKey?.fingerprint === pinned.fingerprint) {
                return undefined;
            }
            if (pinned.fingerprint !== expectedPinnedFingerprint) {
                throw pinnedKeyChanged();
            }
            if (!givenKey && !conflict) {
                throw new ApiError(ApiErrors.NOT_FOUND, 404, "There is no key conflict to accept for this address.");
            }
            // Re-validated now: the conflict's key may have expired since it was observed.
            const newKey: PublicKey = givenKey ?? revalidatedConflictKey(conflict!, address, now);
            keys[pinnedIndex] = newKey;
            audit = {
                action: AuditAction.CONTACT_KEY_REPLACED,
                details: { address, useType, from: pinned.fingerprint, to: newKey.fingerprint },
            };
            return {
                keys,
                keyConflicts: remainingConflicts,
                previousKeys: addPreviousKey(withoutKey(existing.previousKeys, useType, newKey.fingerprint), {
                    ...pinned,
                    replacedAt: now,
                    replacement: "user",
                }),
                rejectedKeys: listField(withoutKey(existing.rejectedKeys, useType, newKey.fingerprint), existing.rejectedKeys),
            } as Partial<C>;
        });

        if (audit) {
            await recordAuditLog(
                this._objectFactory!,
                this.auditLogClass,
                { config: this.config, req, user, logger: this.logger },
                { action: audit.action, targetType: "Contact", targetUid: contact!.uid, mailboxUid: mailbox.uid, details: audit.details },
            );
        }
        return this.toPublic(contact!);
    }
}
