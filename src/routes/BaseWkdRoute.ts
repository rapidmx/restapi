///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The consuming application applies `@Route("/.well-known/openpgpkey")` to its own concrete subclass.
import { ObjectDecorators } from "@rapidrest/core";
import { type HttpRequest, type HttpResponse, ObjectFactory, RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { EncryptionPolicy, KeyVault, Mailbox, PublicKey } from "../models/types.js";
import { DomainUtils } from "../util/DomainUtils.js";
import { discoverLocalKeys, type LocalKeyDiscovery } from "../util/LocalKeyDiscoveryUtils.js";
import { isOpenPgpKey } from "../util/OpenPgpKeyUtils.js";
import { OPENPGP_ALLOWED_CONFIG, OpenPgpPolicy } from "../util/OpenPgpPolicy.js";
import { computeWkdHash, isValidWkdHash } from "../util/WkdUtils.js";
const { Config, Init } = ObjectDecorators;
const { Get, Param, Query, RateLimit, Request, Response } = RouteDecorators;

/**
 * OpenPGP Web Key Directory (draft-koch-openpgp-webkey-service, `specs/end-to-end_encryption.md` *OpenPGP Interoperability*):
 * serves a mailbox's OpenPGP certificate to any OpenPGP implementation - how Proton Mail, GnuPG, Thunderbird and others find
 * the key of a RapidMX address. Public and unauthenticated, like the RapidMX discovery endpoint.
 *
 * - **Direct method**: `GET /.well-known/openpgpkey/hu/<hash>?l=<local>` on the mail domain itself - the domain is the request's `Host`.
 * - **Advanced method**: `GET /.well-known/openpgpkey/<domain>/hu/<hash>?l=<local>` on `openpgpkey.<domain>` - the domain is in the path. A
 * client uses it whenever the `openpgpkey` host exists, so the deployment serves that host too.
 * - `GET .../policy` (both methods): the empty policy file whose presence tells a client the directory exists.
 *
 * `<hash>` is z-base-32 of the SHA-1 of the lowercased local part. The address is resolved from `l` (which every current
 * client sends) and its hash must match; a request without `l` can't be answered, since the hash can't be reversed. The
 * address is looked up as delivery does (aliases, plus-tags, alias domains - `discoverLocalKeys()`), and the answer is the
 * mailbox's newest active OpenPGP certificate, binary (`application/octet-stream`). Anything else - an unknown address, a
 * mailbox without an OpenPGP key, "Allow OpenPGP" off - is a 404, which is what a WKD client expects for "no key here".
 */
export abstract class BaseWkdRoute<M extends Mailbox, K extends KeyVault> {
    protected abstract mailboxClass: any;
    protected abstract keyVaultClass: any;
    protected abstract domainClass: any;

    /** The `EncryptionPolicy` model, read for "Allow OpenPGP" (`OpenPgpPolicy`). Optional: without it, the config default applies. */
    protected encryptionPolicyClass?: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    protected mailboxRepo?: RepoUtils<M>;
    protected keyVaultRepo?: RepoUtils<K>;
    protected domainRepo?: RepoUtils<any>;
    protected domainUtils?: DomainUtils;
    protected openPgpPolicy?: OpenPgpPolicy;

    @Config(OPENPGP_ALLOWED_CONFIG, true)
    protected openPgpAllowedDefault: boolean = true;

    /** Plus-addressing, as delivery resolves it (`mail:plus_addressing:enabled`). */
    @Config("mail:plus_addressing:enabled", true)
    protected plusAddressingEnabled: boolean = true;

    /** How long a client may cache an answer. */
    @Config("mail:discovery:public_endpoint:max_age_seconds", 3600)
    protected maxAgeSeconds: number = 3600;

    @Init
    protected async initialize(): Promise<void> {
        // Set by the ObjectFactory that builds every route.
        const factory: ObjectFactory = this._objectFactory!;
        const repo = async (cls: any): Promise<any> => await factory.newInstance(RepoUtils, { name: cls.name, args: [cls] });
        this.mailboxRepo ??= await repo(this.mailboxClass);
        this.keyVaultRepo ??= await repo(this.keyVaultClass);
        this.domainRepo ??= await repo(this.domainClass);
        this.domainUtils ??= await factory.newInstance(DomainUtils, { name: this.domainClass.name, args: [this.domainRepo] });
        if (!this.openPgpPolicy) {
            const policyRepo: RepoUtils<EncryptionPolicy> | undefined = this.encryptionPolicyClass ? await repo(this.encryptionPolicyClass) : undefined;
            this.openPgpPolicy = new OpenPgpPolicy(policyRepo, this.openPgpAllowedDefault);
        }
    }

    /** The query value matching one element of `Mailbox.aliasAddresses` (the backends store it differently). */
    protected abstract aliasQueryValue(address: string): any;

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

    /** The request's domain for the direct method: its `Host`, without a port. */
    private hostDomain(req: HttpRequest): string {
        return (req.headers["host"] ?? "").toString().split(":")[0].toLowerCase();
    }

    /** The mailbox's newest active OpenPGP certificate for `local@domain`, or `undefined`. */
    private async findKey(domain: string, hash: string, local: unknown): Promise<PublicKey | undefined> {
        if (!domain || !isValidWkdHash(hash) || typeof local !== "string" || local.length === 0 || local.length > 64 || computeWkdHash(local) !== hash) {
            return undefined;
        }
        if (!(await this.openPgpPolicy!.allowed())) {
            return undefined;
        }
        const found = await discoverLocalKeys(this.localKeyDiscovery(), `${local}@${domain}`);
        const now: number = Date.now();
        return (found?.response?.keys ?? [])
            .filter((key) => isOpenPgpKey(key) && key.revokedAt === undefined && key.notAfter > now)
            .reduce<PublicKey | undefined>((newest, key) => (!newest || key.notBefore > newest.notBefore ? key : newest), undefined);
    }

    private async answer(res: HttpResponse, key: PublicKey | undefined): Promise<void> {
        // Clients in browsers read this directory too (the draft asks for an open CORS policy).
        res.setHeader("access-control-allow-origin", "*");
        if (!key) {
            res.status(404).send();
            return;
        }
        const body: Buffer = Buffer.from(key.publicKey, "base64");
        res.setHeader("content-type", "application/octet-stream");
        res.setHeader("content-length", body.length);
        res.setHeader("cache-control", `max-age=${this.maxAgeSeconds}`);
        res.status(200).send(body);
    }

    private policy(res: HttpResponse): void {
        res.setHeader("access-control-allow-origin", "*");
        res.setHeader("content-type", "text/plain");
        res.status(200).send("");
    }

    @RateLimit()
    @Get("/hu/:hash")
    public async direct(
        @Param("hash") hash: string,
        @Query("l") local: unknown,
        @Request req: HttpRequest,
        @Response res: HttpResponse,
    ): Promise<void> {
        await this.answer(res, await this.findKey(this.hostDomain(req), hash, local));
    }

    @Get("/policy")
    public directPolicy(@Response res: HttpResponse): void {
        this.policy(res);
    }

    @RateLimit()
    @Get("/:domain/hu/:hash")
    public async advanced(
        @Param("domain") domain: string,
        @Param("hash") hash: string,
        @Query("l") local: unknown,
        @Response res: HttpResponse,
    ): Promise<void> {
        await this.answer(res, await this.findKey(String(domain ?? "").toLowerCase(), hash, local));
    }

    @Get("/:domain/policy")
    public advancedPolicy(@Response res: HttpResponse): void {
        this.policy(res);
    }
}
