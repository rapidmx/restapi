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
import { AuditAction, Contact, EncryptionPreference, EndToEndFormat, Folder, KeyConflict, Mailbox, PreviousKey, PublicKey } from "../models/types.js";
import { type PreferredFormatSource, resolvePreferredFormat } from "../util/PreferredFormatUtils.js";
import { AuditLogUtils } from "../util/AuditLogUtils.js";
import { ContactKeyMerge, ContactKeyWriteResult, ContactKeyWriteTarget, writeContactKeys } from "../util/ContactKeyUtils.js";
import { DomainUtils } from "../util/DomainUtils.js";
import { hasMailAccess } from "../util/MailAccessUtils.js";
import {
    addPreviousKey,
    addRejectedKey,
    discoverAndMergeKeys,
    listField,
    normalizeKeyConflicts,
    parseAnyContactKey,
    withoutKey,
} from "../util/KeyringUtils.js";
import { LocalKeyDiscovery } from "../util/LocalKeyDiscoveryUtils.js";
import { isPlainAddress } from "../util/MimeHeaderUtils.js";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
import { isOpenPgpKey, keySlot, mergeOpenPgpCertificate, OPENPGP_KEY_TYPE } from "../util/OpenPgpKeyUtils.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;
const { Get, Param, Post, Query, RateLimit, Request, User: AuthUser } = RouteDecorators;

/** The wire shape `GET /mailbox/:id/keys/lookup`, `POST /mailbox/:id/keys/trust` and `POST /mailbox/:id/keys/resolve`
 * return. `keyConflicts` and `previousKeys` are omitted when empty. */
export interface PublicKeyLookupResult {
    keys: PublicKey[];
    encryptPreference?: EncryptionPreference;
    /** The format to use when both are possible (`util/PreferredFormatUtils.ts`'s `resolvePreferredFormat()`): the user's choice for
     * the contact, else what the address advertises, else what it was last seen using. Absent when nothing says. */
    preferredFormat?: EndToEndFormat;
    /** Where `preferredFormat` came from. */
    preferredFormatSource?: PreferredFormatSource;
    keyConflicts?: KeyConflict[];
    previousKeys?: PreviousKey[];
}

/** The body of `POST /mailbox/:id/keys/trust`. */
export interface TrustSignerRequest {
    /** The signer's address, one plain `local@domain`. */
    address: string;
    /** The signer's certificate: base64 DER X.509, or with `type: "openpgp"` an OpenPGP public key (ASCII armored or base64
     * binary). */
    certificate: string;
    /** `"openpgp"` for an OpenPGP key; omitted (or `"x509"`) for an X.509 certificate. */
    type?: string;
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
    /** For `"accept"` only: the new key's certificate, base64 DER X.509 (or an OpenPGP key with `type: "openpgp"`). Defaults
     * to the recorded conflict's key. */
    certificate?: string;
    /** Which of the contact's keys of `useType`: `"openpgp"` for its OpenPGP certificate (always `useType: "encrypt"`),
     * omitted (or `"x509"`) for its X.509 certificate. */
    type?: string;
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

/** The address `conflict`'s key names: the one it was checked against when it was observed (an alias mailbox's primary address), or
 * `address`, the contact's own. */
function conflictAddress(conflict: KeyConflict | undefined, address: string): string {
    return isPlainAddress(conflict?.address) ? conflict.address : address;
}

/** A conflict's observed key, validated as a key of its `useType` and format for `address` at `now` (400 when it no longer
 * is), keeping the `issuerCertificate` it was published with. */
async function revalidatedConflictKey(conflict: KeyConflict, address: string, now: number): Promise<PublicKey> {
    const key: PublicKey = await parseAnyContactKey(conflict.observedKey.publicKey, conflict.observedKey.type, address, conflict.useType, now);
    return conflict.observedKey.issuerCertificate ? { ...key, issuerCertificate: conflict.observedKey.issuerCertificate } : key;
}

/** `type` of a trust or resolve request: `"openpgp"`, or `"x509"` when omitted (400 for anything else). */
function requestKeyType(type: unknown): typeof OPENPGP_KEY_TYPE | "x509" {
    if (type === undefined || type === "x509") {
        return "x509";
    }
    if (type === OPENPGP_KEY_TYPE) {
        return OPENPGP_KEY_TYPE;
    }
    throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'type' must be 'x509' or 'openpgp'.");
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

    protected mailboxRepo?: RepoUtils<M>;
    protected keyVaultRepo?: RepoUtils<any>;
    protected contactRepo?: RecoverableRepoUtils<C>;
    protected folderRepo?: RecoverableRepoUtils<F>;
    protected auditLogRepo?: RepoUtils<any>;
    protected auditLogUtils?: AuditLogUtils;
    protected domainRepo?: RepoUtils<any>;
    protected domainUtils?: DomainUtils;

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

    @Init
    protected async initialize(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        if (!this.mailboxRepo && this.mailboxClass) {
            this.mailboxRepo = await this._objectFactory.newInstance(RepoUtils, {
                name: this.mailboxClass.name,
                args: [this.mailboxClass],
            });
        }
        if (!this.keyVaultRepo && this.keyVaultClass) {
            this.keyVaultRepo = await this._objectFactory.newInstance(RepoUtils, {
                name: this.keyVaultClass.name,
                args: [this.keyVaultClass],
            });
        }
        if (!this.contactRepo && this.contactClass) {
            this.contactRepo = await this._objectFactory.newInstance(RecoverableRepoUtils, {
                name: this.contactClass.name,
                args: [this.contactClass],
            });
        }
        if (!this.folderRepo && this.folderClass) {
            this.folderRepo = await this._objectFactory.newInstance(RecoverableRepoUtils, {
                name: this.folderClass.name,
                args: [this.folderClass],
            });
        }
        if (!this.auditLogRepo && this.auditLogClass) {
            this.auditLogRepo = await this._objectFactory.newInstance(RepoUtils, {
                name: this.auditLogClass.name,
                args: [this.auditLogClass],
            });
        }
        if (!this.auditLogUtils && this.auditLogClass) {
            this.auditLogUtils = await this._objectFactory.newInstance(AuditLogUtils, {
                name: this.auditLogClass.name,
                args: [this.auditLogRepo],
            });
        }
        if (!this.domainRepo && this.domainClass) {
            this.domainRepo = await this._objectFactory.newInstance(RepoUtils, {
                name: this.domainClass.name,
                args: [this.domainClass],
            });
        }
        if (!this.domainUtils && this.domainClass) {
            this.domainUtils = await this._objectFactory.newInstance(DomainUtils, {
                name: this.domainClass.name,
                args: [this.domainRepo],
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
            domainNames: () => this.domainUtils!.getVerifiedDomainNames(),
            aliasQueryValue: (address) => this.aliasQueryValue(address),
            resolveDomainAlias: (address) => this.domainUtils!.resolveDomainAlias(address),
            plusAddressing: this.plusAddressingEnabled,
        };
    }

    private toPublic(contact: C): PublicKeyLookupResult {
        const keyConflicts: KeyConflict[] = normalizeKeyConflicts(contact.keyConflicts);
        const preferred = resolvePreferredFormat(contact);
        return {
            keys: contact.keys ?? [],
            encryptPreference: contact.encryptPreference,
            ...(preferred ? { preferredFormat: preferred.format, preferredFormatSource: preferred.source } : {}),
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
     * `POST /mailbox/:id/keys/trust` with `{ address, certificate, type? }`: pins `certificate` (base64 DER X.509) as the signing
     * key of `address`'s contact in this mailbox - the "Trust this signer" action for a validly signed message whose
     * sender has no signing key pinned. Returns the same shape as `lookup()` for that address.
     *
     * With `type: "openpgp"`, `certificate` is an OpenPGP public key (armored or base64 binary) - from a signed message, a
     * key attached to one, or pasted by the user - validated by `OpenPgpKeyUtils.parseOpenPgpContactKey()` and pinned as the
     * contact's OpenPGP certificate (one key that both encrypts and signs), next to any S/MIME certificates it has. The same
     * rules apply to that slot: only ever the first one, 409 for a different one already pinned.
     *
     * Only ever adds the first signing key. A contact that already pins a signing key gets 409 when it's a different
     * certificate (replacing a pinned key is `resolve()`'s job, which needs the pinned fingerprint the user saw, so this
     * can't be used to substitute a key) and 200 with nothing written when it's the same one - but for an OpenPGP certificate, whose
     * fingerprint is its primary key's: what the given copy adds (an extended expiry, subkeys, revocations) is merged into the pinned one
     * (`mergeOpenPgpCertificate()`). Existing encrypt keys, `encryptPreference` and
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

        if (!body || typeof body !== "object" || Array.isArray(body)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The request body must be an object with 'address' and 'certificate'.");
        }
        const { address, certificate, type } = body as Partial<TrustSignerRequest>;
        if (!isPlainAddress(address)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'address' must be a single plain email address.");
        }
        const keyType = requestKeyType(type);
        const mailbox: M = await this.requireUpdatableMailbox(mailboxId, user);
        const key: PublicKey = await parseAnyContactKey(certificate, keyType, address, "sign");

        const now: number = Date.now();
        const { contact, written } = await this.writeKeys(
            mailbox,
            address,
            user,
            async (existing) => {
                if (existing) {
                    await this.requirePermission(user, existing.folderUid, ACLAction.UPDATE);
                }
                const pinned: PublicKey | undefined = existing?.keys?.find((k) => keySlot(k) === keySlot(key));
                if (pinned) {
                    if (pinned.fingerprint === key.fingerprint) {
                        // The same OpenPGP certificate as it is now: what it adds (an extended expiry, subkeys, revocations) is merged in.
                        const refreshed: PublicKey | undefined = isOpenPgpKey(key) ? await mergeOpenPgpCertificate(pinned, key, now) : undefined;
                        return refreshed ? ({ keys: existing!.keys!.map((k) => (k === pinned ? refreshed : k)) } as Partial<C>) : undefined;
                    }
                    throw new ApiError(
                        ApiErrors.IDENTIFIER_EXISTS,
                        409,
                        isOpenPgpKey(key)
                            ? "A different OpenPGP key is already pinned for this address. It can't be replaced from here."
                            : "A different signing key is already pinned for this address. It can't be replaced from here.",
                    );
                }
                return { keys: [...(existing?.keys ?? []), key], keysFirstSeen: existing?.keysFirstSeen ?? now } as Partial<C>;
            },
            (folder) => this.requirePermission(user, folder.uid, ACLAction.CREATE),
        );

        if (written) {
            await this.auditLogUtils!.record(
                {
                    action: AuditAction.CONTACT_KEY_TRUSTED,
                    targetType: "Contact",
                    targetUid: contact!.uid,
                    mailboxUid: mailbox.uid,
                    details: { address, fingerprint: key.fingerprint, ...(isOpenPgpKey(key) ? { type: OPENPGP_KEY_TYPE } : {}) },
                },
                { req, user },
            );
        }
        return this.toPublic(contact!);
    }

    /**
     * `POST /mailbox/:id/keys/resolve` with `{ address, useType, action, expectedPinnedFingerprint, certificate?, type? }`: the
     * user's explicit decision on a changed key (`specs/end-to-end_encryption.md`'s Key Conflict Handling, step 4).
     * Returns the same shape as `lookup()` for that address. `type: "openpgp"` (with `useType: "encrypt"`) addresses the
     * contact's OpenPGP certificate; otherwise its X.509 certificate of `useType` - each format's key is pinned, and its
     * conflict recorded, on its own.
     *
     * `accept` replaces the pinned `useType` key of `address`'s contact. The new key is `certificate` when given, else the
     * key recorded in that `useType`'s conflict; either way it's validated by `parseContactKey()` at the time of the
     * request (400: unparseable, not currently valid, doesn't name `address`, usage doesn't fit `useType`). Then:
     * - 404 when there's no contact, no pinned `useType` key, or (without `certificate`) no conflict for `useType`;
     * - 200 with nothing written when the given certificate is already the pinned key (checked before the fingerprint
     * match, so a retried accept of the same certificate succeeds) - an OpenPGP one's newer components merged in, as `trust()` does;
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

        if (!body || typeof body !== "object" || Array.isArray(body)) {
            throw new ApiError(
                ApiErrors.INVALID_REQUEST,
                400,
                "The request body must be an object with 'address', 'useType', 'action' and 'expectedPinnedFingerprint'.",
            );
        }
        const { address, useType, action, expectedPinnedFingerprint, certificate, type } = body as Partial<ResolveKeyConflictRequest>;
        if (!isPlainAddress(address)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'address' must be a single plain email address.");
        }
        if (useType !== "sign" && useType !== "encrypt") {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'useType' must be 'sign' or 'encrypt'.");
        }
        const keyType = requestKeyType(type);
        if (keyType === OPENPGP_KEY_TYPE && useType !== "encrypt") {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "An OpenPGP key is resolved with 'useType' 'encrypt'.");
        }
        const slot: string = keySlot({ useType, type: keyType });
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
        // A given certificate names the contact's address - or, for an alias mailbox's, its primary address, which only the conflict knows.
        let givenKey: PublicKey | undefined;
        let givenError: unknown;
        if (certificate !== undefined) {
            try {
                givenKey = await parseAnyContactKey(certificate, keyType, address, useType, now);
            } catch (err) {
                givenError = err;
            }
        }

        let audit: { action: AuditAction; details: Record<string, string> } | undefined;
        const { contact } = await this.writeKeys(mailbox, address, user, async (existing) => {
            audit = undefined;
            if (!existing) {
                throw new ApiError(ApiErrors.NOT_FOUND, 404, "There is no contact for this address.");
            }
            await this.requirePermission(user, existing.folderUid, ACLAction.UPDATE);
            const keys: PublicKey[] = [...(existing.keys ?? [])];
            const pinnedIndex: number = keys.findIndex((k) => keySlot(k) === slot);
            const pinned: PublicKey | undefined = keys[pinnedIndex];
            const conflicts: KeyConflict[] = normalizeKeyConflicts(existing.keyConflicts);
            const conflict: KeyConflict | undefined = conflicts.find((c) => keySlot(c.observedKey) === slot);
            const remainingConflicts = listField(
                conflicts.filter((c) => keySlot(c.observedKey) !== slot),
                existing.keyConflicts,
            );
            if (givenError !== undefined && !givenKey) {
                if (conflictAddress(conflict, address) === address) {
                    throw givenError;
                }
                givenKey = await parseAnyContactKey(certificate, keyType, conflictAddress(conflict, address), useType, now);
            }

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
                // The pinned OpenPGP certificate as it is now: what it adds is merged in, as discovery does (`mergeOpenPgpCertificate()`).
                const refreshed: PublicKey | undefined = isOpenPgpKey(givenKey) ? await mergeOpenPgpCertificate(pinned, givenKey, now) : undefined;
                if (!refreshed) {
                    return undefined;
                }
                keys[pinnedIndex] = refreshed;
                return { keys } as Partial<C>;
            }
            if (pinned.fingerprint !== expectedPinnedFingerprint) {
                throw pinnedKeyChanged();
            }
            if (!givenKey && !conflict) {
                throw new ApiError(ApiErrors.NOT_FOUND, 404, "There is no key conflict to accept for this address.");
            }
            // Re-validated now: the conflict's key may have expired since it was observed.
            const newKey: PublicKey = givenKey ?? (await revalidatedConflictKey(conflict!, conflictAddress(conflict, address), now));
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
            await this.auditLogUtils!.record(
                { action: audit.action, targetType: "Contact", targetUid: contact!.uid, mailboxUid: mailbox.uid, details: audit.details },
                { req, user },
            );
        }
        return this.toPublic(contact!);
    }
}
