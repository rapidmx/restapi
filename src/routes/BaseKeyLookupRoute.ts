///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The consuming application must apply `@Route("/mailbox")` to its own concrete subclass (see
// `BaseMailIngestRoute`'s identical note) - `@Get("/:id/keys/lookup")` below then resolves to
// `GET /mailbox/:id/keys/lookup`.
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import { ACLAction, ACLUtils, ApiErrorMessages, ApiErrors, ObjectFactory, RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import type { DnsResolver } from "../dns/DnsResolver.js";
import { Contact, ContactAddressKind, Folder, FolderType, Mailbox } from "../models/types.js";
import { findOrCreateWellKnownFolder } from "../util/FolderUtils.js";
import { discoverAndMergeKeys, KeyringUpdate } from "../util/KeyringUtils.js";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
const { Inject } = ObjectDecorators;
const { Get, Param, Query, RateLimit, User: AuthUser } = RouteDecorators;

/** The wire shape `GET /mailbox/:id/keys/lookup` returns. */
export type PublicKeyLookupResult = KeyringUpdate;

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

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private mailboxRepo?: RepoUtils<M>;
    private contactRepo?: RecoverableRepoUtils<C>;
    private folderRepo?: RecoverableRepoUtils<F>;

    @Inject(ACLUtils)
    private aclUtils?: ACLUtils;

    @Inject("DnsResolver")
    private dnsResolver?: DnsResolver;

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
     * query possible at all, so `BaseKeyLookupRouteSQL` overrides this the same way `ScanQueueJobSQL` does.
     */
    protected contactEmailQuery(address: string): any {
        return { "emails.address": address };
    }

    private toPublic(contact: Pick<C, "keys" | "encryptPreference" | "keyConflict">): PublicKeyLookupResult {
        return { keys: contact.keys ?? [], encryptPreference: contact.encryptPreference, keyConflict: contact.keyConflict };
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
        const mailbox: M | undefined = await this.mailboxRepo!.findOne(mailboxId, { ignoreACL: true });
        if (!mailbox) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        if (!(await this.aclUtils!.hasPermission(user, mailbox.uid, ACLAction.UPDATE))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }

        const existingMatches: C[] = await this.contactRepo!.find(
            { mailboxUid: mailbox.uid, limit: 1, ...this.contactEmailQuery(addr) },
            { ignoreACL: true, limit: 1 },
        );
        const existingContact: C | undefined = existingMatches[0];

        const update = await discoverAndMergeKeys(this.dnsResolver!, addr, existingContact);
        if (!update) {
            if (!existingContact) {
                throw new ApiError(ApiErrors.NOT_FOUND, 404, "No keys could be discovered for this address.");
            }
            return this.toPublic(existingContact);
        }

        if (existingContact) {
            const updated: C = await this.contactRepo!.update(
                { uid: existingContact.uid, version: (existingContact as any).version, ...update } as any,
                existingContact,
                { user, ignoreACL: true },
            );
            return this.toPublic(updated);
        }

        const folder: F = await findOrCreateWellKnownFolder(this.folderRepo!, this.folderClass, mailbox.uid, FolderType.CONTACTS, user);
        const created: C = await this.contactRepo!.create(
            new this.contactClass({
                mailboxUid: mailbox.uid,
                folderUid: folder.uid,
                displayName: addr,
                emails: [{ address: addr, type: ContactAddressKind.OTHER }],
                phones: [],
                addresses: [],
                ...update,
            }),
            { user, ignoreACL: true },
        );
        return this.toPublic(created);
    }
}
