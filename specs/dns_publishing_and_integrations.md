# RapidMX: DNS Publishing and Admin-Console Integrations

This document is the technical design for linked features across `@rapidmx/restapi`, `@rapidmx/server`, `@rapidmx/web-client`, `postfix-bridge`, `@rapidmx/meet-plugin` and a new project, `rapidmx/dns-controller` (§7):

1. **DNS publishing.** RapidMX publishes every DNS record a deployment and its domains need, through [external-dns](https://github.com/kubernetes-sigs/external-dns), using per-domain DNS provider configurations an administrator manages in the admin console.
2. **DKIM rotation.** Each domain's DKIM key rotates on a schedule (and on demand), with the new selector published and observed live before signing switches to it.
3. **Integrations.** Third-party services an administrator chooses (DNS providers, Giphy, STUN, the S/MIME signing CA, the DNS resolver, the plugin registry) move from deployment-only configuration to typed, audited, live-applied settings in the admin console, with their secrets held outside the database.
4. **Domain seeding.** The domains a deployment is installed for exist in the server from its first start, instead of being added again by hand in the admin console.

The decisions this document implements were made with JP on 2026-10-27 and are not re-litigated here (see *Resolved Decisions*). It supersedes the beta.46 stopgap that made the `openpgpkey.<domain>` host opt-in. The last proposal, the opt-in takeover of a domain's apex TXT set for SPF (§9.4), is now **DECIDED** by JP: the root TXT set is never overwritten without the admin's per-domain opt-in.

## 1. Why

The Helm chart cannot know whether a host's DNS record exists. A feature that needs a host either breaks an install or upgrade (Helm 4's `--wait` waits on cert-manager `Certificate`s, which cannot be issued for a name without a record) or ships disabled. Today that applies to `openpgpkey.<domain>` and, equally, to `mail.`, `auth.` and `autodiscover.` and to each domain's MX, SPF, DKIM and DMARC records, all of which an operator copies by hand from the admin console's DNS checklist (`GET /mail/domains/:id/dns-setup`).

Publishing those records ourselves removes the manual step, so hosts can default on, a domain added in the admin console starts receiving mail without a trip to the registrar, and DKIM keys can finally rotate.

## 2. Current Architecture

Grounding for the design below. Paths are relative to each repo.

### 2.1 What the server recommends (restapi)

`src/util/DnsSetupUtils.ts` `checkDnsSetup(dnsResolver, domain, mxHostname, autodiscoverHostname?)` computes and live-checks, per `Domain`:

| `DnsRecordType` | Kind | Name | Recommended value | Configured when |
| --- | --- | --- | --- | --- |
| `ownership` | TXT | `_rapidmx-verify.<domain>` (the apex until restapi step 3, §6.5) | `rapidmx-domain-verification=<verificationToken>` | always |
| `mx` | MX | `<domain>` | `10 <mail:dns:mx_hostname>` | `mail:dns:mx_hostname` set |
| `spf` | TXT | `<domain>` | `v=spf1 mx ~all` | always |
| `dkim` | TXT | `<dkimSelector>._domainkey.<domain>` | `v=DKIM1; k=rsa; p=<dkimPublicKey>` | selector and key set |
| `dmarc` | TXT | `_dmarc.<domain>` | `v=DMARC1; p=<dmarcPolicy ?? none>;[ rua=mailto:<dmarcReportEmail>;]` | always |
| `openpgpkey_cname` | CNAME | `openpgpkey.<domain>` | `<mail:dns:mx_hostname>` | `mx_hostname` set |
| `autodiscover_cname` | CNAME | `autodiscover.<domain>` | host of `mail:autodiscover:public_url` | autodiscover plugin active |
| `autodiscover_srv` | SRV | `_autodiscover._tcp.<domain>` | `0 0 443 <that host>` | autodiscover plugin active |

`DnsRecordCheck` is always computed fresh and never persisted. The results are checked against the public DNS through the injected `DnsResolver` (`node` or the server's `DohDnssecDnsResolver`, selected by `mail:dns:resolver`).

### 2.2 Domains (restapi)

`src/routes/BaseDomainRoute.ts` (mounted by the server at `mail/domains`) is trusted-role-only CRUD over `Domain`:

- `uid` is the normalized `name`. A rename is refused (delete and re-create).
- `verified`, `verificationToken`, `verifiedAt` and `lastCheckedAt` are server-managed (`SERVER_MANAGED_DOMAIN_FIELDS`). `verified` is never flipped back once true.
- `create()` mints a `verificationToken` and calls `ensureDkimFields()`, which asks the injected `DkimKeyProvider` for a key pair unless the caller sent both `dkimSelector` and `dkimPublicKey`.
- `POST /:id/verify` and `DomainVerificationJob` (`mail:jobs:domain_verification:schedule`, every 5 minutes) flip `verified` when the TXT record is found (`checkDomainVerification()` in `src/util/DomainVerificationUtils.ts`: any apex TXT record equal to `rapidmx-domain-verification=<token>`).
- `GET /:id/dns-setup` backfills a missing DKIM key pair, then returns `checkDnsSetup()`.
- Every create, update, delete and verification writes an `AuditLogEntry` (`DOMAIN_CREATE`/`UPDATE`/`DELETE`/`VERIFIED`).
- A pure alias domain (`aliasOf`) has its own ownership proof and DKIM key, and its own DNS records.
- The list of "this server's domains" at runtime is always the verified `Domain` rows (`DomainUtils.getVerifiedDomainNames()`, used by ingest, transport rules and the MTA's relay-domain lookup), never config.

### 2.3 DKIM keys and signing

- **Key custody (restapi, registered by the server).** `FsDkimKeyProvider` lives in restapi (`src/dkim/FsDkimKeyProvider.ts`); the server registers it (`server/src/lib/registerCoreProviders.ts`): one RSA key per domain at `<mail:dkim:key_dir>/<domain>.<mail:dkim:selector>.key` (default `/var/lib/rspamd/dkim/<domain>.mail.key`), on the `<fullname>-dkim-keys` PVC (`server/helm/templates/0_config/mail-storage.yaml`). The selector is one global value for every domain.
- **Signing (postfix-bridge).** Outbound mail is signed by **OpenDKIM inside the Postfix container** (`boky/postfix` image) of the `postfix-bridge` chart, bundled as the server chart's `postfixBridge` subchart. rspamd does not sign (its chart comment says so). The Postfix pod mounts the same PVC; its `dkim-keys-sync` init container and the `dkim-sync.sh` watcher (`postfix-bridge/helm/templates/0_config/mail-tls-policy.yaml`, run under supervisord) copy `<domain>.<DKIM_SELECTOR>.key` to `/etc/opendkim/keys/<domain>.private` every `DKIM_SYNC_INTERVAL` seconds, rebuild `KeyTable`/`SigningTable` with the one global selector, and send OpenDKIM `SIGUSR1` to reload. The mount is read-write in the Postfix container.
- **SES.** With `SesMailTransport`, SES signs with its own Easy DKIM, and `DkimKeyProvider` keys are not used.
- **No rotation.** `DkimKeyProvider.ensureKeyPair()` is documented as never rotating, and the single global selector in both the server and `dkim-sync.sh` makes a per-domain selector change impossible today.

### 2.4 Policy singletons (restapi)

`BaseMailboxPolicyRoute` (`system/mailbox-policy`) and `BaseEncryptionPolicyRoute` (`system/encryption-policy`) are the pattern Integrations follows:

- A singleton row, seeded from `@Config` values the first time it is read (`findOrSeedMailboxPolicy()`).
- The response carries `defaults`, read from config on every request, which is what the console's per-field "reset" puts a field back to. A row field that is missing (`null` on SQL) takes the config value.
- `PUT` is `@RequiresTrustedRole()` and writes an audit entry with the patch.
- Elevation (`assertAdminScope(user, trustedRoles, mail:security:elevation_max_age_seconds)`) is required for administrative actions with a larger blast radius (plugins, escrow, data export, erasure).

### 2.5 Plugin settings (restapi + server)

- A plugin's settings are saved on its `Plugin` row (`Plugin.settings`), **in plaintext**, and loaded by the server's plugin host into the first nconf layer (`PLUGIN_SETTINGS_STORE = "plugins"`), so a saved setting wins over the command line, environment and defaults.
- `CORE_CONFIG_NAMESPACES` (`src/plugins/PluginUtils.ts`, mirrored by the server's `PROTECTED_PLUGIN_SETTING_KEYS` in `src/config.defaults.ts`) lists the namespaces a plugin setting may never **declare or save**. `giphy`, `mail:dns`, `mail:pki`, `mail:domains` and `system:plugins` are on it. Reading is not restricted: the meet plugin already reads `trusted_roles` and `auth` with `@Config`.
- A secret setting (`isSecretSetting()`: key words, `secret: true` or `type: "password"` in the manifest) is masked in responses as `{ "secret": true }` (`maskSecretSettings()`), and sending the mask back means "left alone" (`isSecretMask()`; both helpers, with `secretMask()`, now live in `src/secrets/SecretMask.ts`, shared with the secret store, 5.1).
- The server's Diagnostics page hides config values named on an explicit list (`server/src/diagnostics/hiddenSettings.ts`, which already lists `giphy:api_key`, `system:plugins:registry_token` and `mail:pki:openbao:token`), never by name-guessing.

### 2.6 Kubernetes, OpenBao and configuration (server)

- The server already talks to the Kubernetes API, from `src/diagnostics/KubeClient.ts`: a small hand-written HTTPS client using the pod's service account token (re-read on every request, since bound tokens rotate), its namespace file and the cluster CA. It is GET-only and deliberately avoids `@kubernetes/client-node`.
- The chart grants it one **namespace Role** (`helm/templates/0_config/diagnostics-rbac.yaml`: `get`/`list` on `pods`, `persistentvolumeclaims` and `metrics.k8s.io` `pods`), bound to the chart's ServiceAccount, behind `global.diagnostics.rbac.create`. There is no ClusterRole, per the standing rule.
- The ServiceAccount (`0_config/service-account.yaml`) is created by default (`global.serviceAccount.create: true`; the template comment saying "off by default" is stale). The server pod mounts its token; clamav, coturn and rspamd do not.
- OpenBao, when the installer installs or uses it (`--openbao`, default true), runs in namespace `openbao` with a **plain-HTTP** listener (`http://openbao.openbao.svc:8200`) and holds the release's secrets at `<kv mount>/<fullname>/secrets`. External Secrets (`helm/templates/4_vault/external-secrets.yaml`, `SecretStore <fullname>-openbao`) syncs them into the Kubernetes Secrets the pods read. `prepareOpenbao()` enables KV v2, a PKI mount, two read-only policies and two **orphan periodic tokens** (`<fullname>-openbao-eso`, `<fullname>-openbao-pki`); **no Kubernetes auth method is enabled**, although the chart's `SecretStore` already supports `global.openbao.auth.method: kubernetes`.
- The server process does not talk to OpenBao at runtime today. restapi's `OpenBaoPkiCertificateAuthority` (static token, `mail:pki:openbao:token`) exists, but the chart never sets `mail__pki__backend`, and its `assertSafeAddress()` refuses plain HTTP to any non-loopback host, so the in-cluster address would be refused anyway.
- **Every config value is a startup snapshot.** `@Config` fields are assigned once by `ObjectFactory` at instantiation (its `config` is `protected`), and `registerCoreProviders()` picks the `DnsResolver`, CA and signing-enrollment implementations once per process. Saving a plugin setting changes `computePluginStateHash()`, which makes `PluginWatcher` roll every replica's worker under a Redis restart lock (`PluginRestartLock`).
- There is no general leader election. The reusable single-writer pieces are the Redis lock in `src/plugins/PluginWatcher.ts` and the DB lease in `src/plugins/PluginPurgeLedger.ts`.
- The server never learns its public addresses, and the installer detects none: its final message tells the operator to point A/AAAA "to this machine". The only address detection anywhere is coturn's `detect-external-ip`. The only DNS automation is `deploy/aws/bootstrap.sh`'s optional Route 53 `upsertCname()`.
- List-valued config reaches the server as a JSON string in the service ConfigMap (e.g. `cors__origins: {{ $origins | toJson | quote }}`), parsed by nconf's `.env({ separator: "__", parseValues: true })`.

### 2.7 The installer and setup (server, web-client)

`single_node_install.sh` takes `--domain`, `--mail-host`, `--auth-host`, `--mail-domains` (default `<domain>`, passed to `postfixBridge.domains`), `--openbao`, `--openpgpkey-host`, `--tls`, `--gateway`, `--install-cert-manager`, `--uninstall` and others, and installs cert-manager and External Secrets cluster-wide. Its final message tells the operator to "Add each domain in the admin console, publish the DNS records it shows". The first-run setup wizard (web-client `apps/shared/components/admin/setup/SetupWizard.tsx`, steps `plugins`, `domain`, `settings`, `escrow`, `mailboxes`, `branding`) makes the administrator add that same domain again. `BaseSetupRoute.toStatus()` reports setup `required` on a deployment that has started the wizard or has no domains.

### 2.8 `mail:domains`

Nothing reads `mail:domains` at runtime. It is on the protected-namespace lists, the doc comments of `TransportRuleUtils.buildTransportRuleContext()` and of the transport-rule `anyRecipientExternal` condition in `models/types.ts` still call the list "configured `mail:domains`" (stale: the caller passes `getVerifiedDomainNames()`; corrected in restapi step 6), and the only writer is the server's `yarn dev` helper (`src/dev/enableDevAutoLogin.ts`), which sets `["example.com"]`. This design gives the key its meaning back (§13).

## 3. Concepts

- **DNS provider config** (`DnsProvider`): a named, admin-managed configuration of one DNS hosting account: its type (`cloudflare`, `route53`, ...), non-secret options, the zones it may touch, and a reference to its credentials in the secret store.
- **Assignment**: each `Domain` has `dnsProviderUid`, naming a provider config, or nothing ("manual": the admin publishes records by hand, exactly as today).
- **Desired state**: what the server says must be published: provider configs, their assignments and the desired records for each domain and for the deployment's own hosts. The server computes and stores it; it never writes to Kubernetes.
- **DNS controller**: a separate, single-replica pod with its own ServiceAccount and namespace Role, built from its own project and image (`rapidmx/dns-controller`). It reads the desired state from the server through a versioned internal API and is the only RapidMX component that creates or changes Kubernetes objects (§7).
- **Publication**: the controller writes the desired records as `DNSEndpoint` custom resources. One external-dns instance per provider config reads only the ones labelled for it and applies them at the provider.
- **Secret store**: where credentials live. OpenBao KV when the deployment has OpenBao, else Kubernetes Secrets in the release namespace. Never the database.

## 4. Data Model (restapi)

### 4.1 `DnsProvider`

New entity, Mongo and SQL, deny-all class ACL like every admin entity.

```ts
export type DnsProviderType = "cloudflare" | "route53" | "rfc2136" | "google" | "azure";

export interface DnsProvider extends BaseEntity {
    /** Server-generated, stable, DNS-label-safe (lowercase letters, digits, hyphens; at most 40 characters). It names the
     * external-dns Deployment, its Secret and its label value, so it never changes. */
    uid: string;
    /** Display name, unique (case-insensitive). */
    name: string;
    /** `name` in lowercase, under a unique index on both backends, so two writes racing past the name check can't both save the same
     * name (the loser gets the same 409). Server-set, never returned. */
    nameKey: string;
    type: DnsProviderType;
    /** The zones (apex names) this config may publish into: external-dns's --domain-filter. At least one. A Domain may be
     * assigned to this config only when its name is one of these or under one of them. */
    zones: string[];
    /** Non-secret, type-specific options, validated per type (4.2), with every default filled in. A value is text, a number, a switch or a
     * list of text (Cloudflare's `zoneIds`, rfc2136's `hosts`). */
    options: Record<string, string | number | boolean | string[]>;
    /** Where the credentials are: a reference, never the value (5). Unset until credentials are saved (and for a config that needs none:
     * Route 53 through IRSA, unsigned rfc2136); `null` once every credential was cleared. */
    secretRef?: SecretRef | null;
    /** Set by the installer for the config it created, so the console can say where it came from. */
    origin?: "installer" | "console";
    /** Admin on/off. A disabled config's external-dns instance is scaled to zero; its records stay as they are. */
    enabled: boolean;
    /** Allow the takeover of records this deployment does not own yet in these zones (9). Default false. */
    allowTakeover: boolean;
    /** Written only from the controller's status reports (7.7). Never client-settable. */
    status?: DnsProviderStatus | null;
}

/** What the controller last reported (7.7); every field optional, since a config the controller hasn't reported on has none. */
export interface DnsProviderStatus {
    reportedAt?: Date;
    readyReplicas?: number;
    image?: string;
    lastRolloutAt?: Date;
    lastSyncAt?: Date;
    registryErrors?: number;
    sourceErrors?: number;
    providerErrors?: number;
    ownerMismatchRecords?: number;
    lastError?: string;
}

export interface SecretRef {
    backend: "openbao" | "kubernetes";
    /** OpenBao: the KV path under the deployment's integrations prefix. Kubernetes: the key prefix inside the Secret (5.2). */
    path: string;
    /** The keys present (never their values), so the console can show "set" per field. */
    keys: string[];
    /** Bumped on every credentials write: the Deployment's pod-template annotation, so a new credential rolls the pod. */
    generation: number;
}
```

### 4.2 Provider types

Each type declares its options and its secret fields. Option values are validated (types, enumerations, host names); unknown keys are refused. All values become external-dns arguments or environment variables (7.4); none is interpolated into a shell or a file path.

| Type | Options (non-secret) | Secret fields | external-dns provider | Tested |
| --- | --- | --- | --- | --- |
| `cloudflare` | `zoneIds` (required: one per zone, passed as `--zone-id-filter`, which is what lets a token scoped to one zone work). Proxying is never offered: mail hosts must not be proxied, and external-dns forces MX/TXT/SRV unproxied anyway. | `apiToken` (required) | `cloudflare`, env `CF_API_TOKEN` | e2e (powerlevel.gg) |
| `route53` | `region`, `zoneType` (`public`/`private`, default public), `assumeRoleArn`? | `accessKeyId`, `secretAccessKey` (both or neither: neither means IRSA on the external-dns ServiceAccount) | `aws`, env `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION` | unit only |
| `rfc2136` | `hosts`, `port` (53), `zone`, `tsigKeyName`, `tsigAlgorithm` (`hmac-sha256` ...), `insecure` (bool, default false); `--rfc2136-axfr` always on (sync needs it) | `tsigSecret` (base64, required unless `insecure`) | `rfc2136`, env `EXTERNAL_DNS_RFC2136_TSIG_SECRET` (every flag has an `EXTERNAL_DNS_<FLAG>` variable) | unit + CI (bind9) |
| `google` | `project` | `serviceAccountJson` | `google`, mounted file + `GOOGLE_APPLICATION_CREDENTIALS` | unit only |
| `azure` | `tenantId`, `subscriptionId`, `resourceGroup` | `clientId`, `clientSecret` | `azure`, `azure.json` (`aadClientId`/`aadClientSecret`) mounted from the Secret, `--azure-config-file` | unit only |

Providers that are not live-tested carry `tested: false` in `GET /types`, and the console marks them "not yet live-tested".

The registry is `src/dns/DnsProviderTypes.ts` (restapi). Beyond the table, as implemented: Cloudflare's `zoneIds` are 32-character hex ids, one per zone **in the order of `zones`**, never repeated; rfc2136's `zone` must be one of `zones`, `tsigKeyName` is required unless `insecure`, and `tsigAlgorithm` is one of `hmac-sha1`/`-sha224`/`-sha256` (default)/`-sha384`/`-sha512`; Route 53's `region` and `assumeRoleArn`, Google's `project` and Azure's GUIDs and resource group are checked for shape. Credential values are checked for shape too (an AWS access key id, a base64 TSIG secret, a JSON object for Google's key file, a GUID client id), with errors that name the field and never repeat the value. A config that needs no credentials (Route 53 through IRSA, unsigned rfc2136) needs no secret store either.

Facts checked against external-dns v0.23.0's source and docs (2026-10-26):

- **DigitalOcean is not offered**: its in-tree provider was removed in v0.21.0 and is only reachable through a third-party webhook provider. DigitalOcean and webhook providers come later.
- **Record kinds per provider.** MX is supported by cloudflare, aws, google and azure. **rfc2136 cannot manage MX or SRV**: it writes them but its AXFR reader skips them, so they can never be updated or deleted. For an rfc2136 config the controller publishes A/AAAA/CNAME/TXT only, and the MX and SRV records show as **manual** (with the reason) for the admin to keep by hand.
- MX targets are `"<preference> <host>"`; SRV targets must end with `.`; A/AAAA targets must not end with `.`.
- **TXT targets are written quoted** in a `DNSEndpoint` (`"\"v=spf1 mx ~all\""`, i.e. the target string itself begins and ends with `"`), the same form the TXT registry writes its own ownership records in. Proven on Cloudflare by the takeover spike (2026-10-27, §9.3); Route 53 is expected to need the same and is covered by unit tests against recorded API fixtures plus the "not yet live-tested" badge until it is live-tested. One helper (`quoteTxtTarget()`, in the controller) does it, and the golden manifests test it.
- **Cloudflare tokens with a client-IP restriction** must list every address the cluster egresses from, IPv4 **and** IPv6: the spike's token was restricted to the node's IPv4 address and its calls failed whenever the pod went out over IPv6. The console's Cloudflare form and the installer's documentation say so.

### 4.3 `Domain` additions

| Field | Meaning |
| --- | --- |
| `dnsProviderUid?: string \| null` | The provider config publishing this domain's records; unset or `null` means manual. Set only through `PUT /:id/dns-provider` (10.4). Must name an existing `DnsProvider` whose `zones` cover the domain. |
| `origin?: "seed" \| "console" \| null` | `"seed"` for a domain the server created from `mail:domains` (13), `"console"` for one added through `POST mail/domains` (as implemented in restapi step 6; a client can't choose it). Unset on existing rows, which count as console-created. Server-managed. |
| `dnsPublication?: DnsPublicationStatus` | Written from the controller's status reports and the live check, see 4.4. Server-managed. |
| `dkimRotation?: DkimRotationState` | Rotation state, see 6.2. Server-managed. |
| `dkimManaged?: boolean \| null` | `true` when the current key came from the `DkimKeyProvider` (rotation possible), `false` when an admin imported `dkimSelector`/`dkimPublicKey` by hand (never rotated automatically). Set on create (`false` when the caller sent both fields), on a DKIM backfill (`true`) and on a `PUT` that changes either field (`false`). Unset on rows from before restapi step 4 until the rotation job or a rotate request asks the provider whether it holds that key (`findKeyPair()`, 6.2) and records the answer. Server-managed. |
| `apexTxt?: { managed: boolean; keep: string[]; spf?: string } \| null` | **DECIDED (§9.4).** Whether RapidMX owns the domain's apex TXT set to publish SPF, the foreign values it keeps in that set, and the SPF value it publishes there (chosen at opt-in). Set only through `PUT /:id/apex-txt` (trusted role and elevation, audited). Unset means not managed. `keep` stays on the row after opting out, so the console can show what was restored. |

All of them join `SERVER_MANAGED_DOMAIN_FIELDS`, each with the restapi step that adds it (`dnsProviderUid` and `dnsPublication` in step 2; `apexTxt` and `dkimRotation` in step 3, which reads the rotation's `next`/`previous` selectors for the `dkim_next`/`dkim_previous` records; step 4 writes it and adds `dkimManaged`; `origin` in step 6). As the code already treats `verified` and the other server-managed fields: a plain `PUT` **drops** them (so a console round-tripping a domain still works), `PUT /:id/:property` **refuses** them (403), and a create never takes them.

### 4.4 Publication status

```ts
export interface DnsPublicationStatus {
    /** The DNSEndpoint resources the controller last applied for this domain, and what external-dns has observed. */
    endpoints: { name: string; generation: number; observedGeneration?: number }[];
    /** Per record (same identity as DnsRecordCheck: type + recordName). */
    records: DnsRecordPublication[];
    lastReconciledAt?: Date;
    lastError?: string;
}

export interface DnsRecordPublication {
    type: DnsRecordType | "host_a" | "host_aaaa" | "host_cname";
    recordName: string;
    recordKind: "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "SRV";
    /** "published": external-dns observed it and the live lookup sees it (7.5); "pending": applied, not yet live;
     * "conflict": a record at this name exists that this deployment does not own (9); "manual": the admin publishes it,
     * with `manualReason`. */
    state: "published" | "pending" | "conflict" | "manual";
    manualReason?: "no_provider" | "kind_unsupported" | "outside_zones" | "apex_txt_unmanaged";
}
```

`DnsRecordCheck` gains an optional `publication?: DnsRecordPublication["state"]` (and `manualReason`), so `GET /:id/dns-setup` keeps its shape and the console can show "Automatic: published / pending / conflict" or "Manual" next to the live check. The live check (`found`/`matches`) stays the source of truth for "is it working". As implemented (restapi step 3), `checkDnsSetup()` computes the state when asked (`options.publication`; the route always asks) and only for a configured record:

- **manual**, with the first reason that applies, in this order: `no_provider` (none assigned, or the one assigned is gone), `outside_zones`, `kind_unsupported`, `apex_txt_unmanaged` (`dnsManualReason()`).
- **conflict**: a live record is there and external-dns's registry record for it (`rmx-<kind>.<name>`) does not name this deployment's owner id (`rapidmx-<installationId>`), whether or not the value matches. Not reported while the owner id can't be read.
- **published**: the live check matches, the live values at the name are **exactly** the desired ones (each once, in any order; host names without case or the final dot), and external-dns has observed the domain's endpoint (`observedGeneration >= generation` in `dnsPublication.endpoints`, from the status reports). The exact comparison matters because the live check's own `matches` is looser ("is it working": any DMARC record, an SPF with `mx`, a DKIM record carrying the key) and the observed generation can be the one from before the latest change: a stricter DMARC policy, or a value added to a managed apex set, stays pending until it is live.
- **pending**: anything else.

The `ownership` check also carries `legacyApex: true` while the token is (still) at the domain's root (§6.5).

### 4.5 `IntegrationSettings`

One singleton row (`uid: "integrations"`, `INTEGRATION_SETTINGS_UID`), Mongo and SQL (one JSON column per section on SQL), deny-all class ACL:

```ts
export interface IntegrationSettings extends BaseEntity {
    giphy?: { enabled?: boolean; apiKeyRef?: SecretRef } | null;
    stun?: { urls?: string[] } | null;
    signingCa?: { backend?: "rfc8823" | "manual" | "none"; directoryUrl?: string; contactEmail?: string } | null;
    dnsResolver?: { mode?: "node" | "doh-dnssec"; dohEndpoint?: string } | null;
    pluginRegistry?: { url?: string; tokenRef?: SecretRef; namespaces?: IntegrationPluginNamespace[]; namespaceTokensRef?: SecretRef } | null;
}

/** A `PluginNamespace` without its token. */
export interface IntegrationPluginNamespace { name: string; registry?: string }
```

A field left unset means "use the deployment's configured value"; reset deletes the field (a section with nothing left is `null`). DNS providers are their own entity, but the console groups them under Integrations.

As implemented (restapi step 5):

- **Not seeded from config**, unlike `MailboxPolicy` (first drafted as "seeded from config like `MailboxPolicy`"): the row is created empty by the first change. Copying config into it would report the deployment's values as the administrator's (`source: "admin"`, 10.2) and stop a later change of the deployment's config from applying, against "unset means the deployment's value".
- **No plaintext in the row.** The secrets are in the `SecretStore` under `server/`: the Giphy key under `server/giphy` (key `apiKey`), the registry token under `server/plugin-registry` (key `token`). A `PluginNamespace` can carry its own npm `token`, so the namespaces are stored without it (`IntegrationPluginNamespace`; first drafted as `PluginNamespace[]`, which would have put those tokens in the database) and their tokens go to one secret under `server/plugin-namespaces`, one key per namespace: `ns-<the scope in hex>` (`pluginNamespaceTokenKey()`), since a Kubernetes Secret's keys can't hold `@` or `~`. `namespaceTokensRef` points at it.
- **A path per write.** Each write of one of these secrets goes to a new path, `<base>-<16 random hex digits>` (`integrationSecretPath()`, e.g. `server/giphy-3f9c...`), never over the secret the row names; the one the row named before is removed once the row is saved. A row that then can't be saved leaves the secret in use exactly as it was (the new one is removed again), so no secret changes without its audit entry, and two writes racing each other never share a store entry, so one's clear can't remove the other's new value. (First built with one fixed path per secret, which an independent review showed changed the live secret unaudited when the row write failed, and let racing writes delete each other's values.) Changing kept namespace tokens reads them from the secret in use and writes them with the new ones to the new path.

### 4.6 Installation identity

A singleton row `DeploymentIdentity { installationId }`: a random 16-character value created once, the stable part of the external-dns owner id (7.4). It never changes for the life of the database.

### 4.7 Audit actions

`DOMAIN_VERIFIED` (details now carry `location`: `record` or `legacy_apex`, §6.5), `DNS_PROVIDER_CREATE` (details: name, type, zones, option keys, `credentialsChanged`), `DNS_PROVIDER_UPDATE` (details: name, the changed fields, changed option keys, `credentialsChanged: boolean`, never values; `secretLeftBehind: true` when credentials in a backend the deployment no longer uses were left there; `rowWriteFailed: true` with `rowMatchesStore` when the store changed but the row's write then failed, see 10.1), `DNS_PROVIDER_DELETE` (details: name, type, `secretLeftBehind` when the credentials could not be removed from the store), `DOMAIN_DNS_PROVIDER_ASSIGN` (details: domain name, from, to; `null` for manual), `DNS_PROVIDER_TEST` (details: name, the queued operation), `DNS_TAKEOVER` (details: provider, domain, record names, the old values as the live lookup saw them, the queued operation; for an apex TXT opt-in also `keep` and `spf`), `DOMAIN_APEX_TXT_UPDATE` (details: domain name, `managed`, `keep`: an edit of the kept values, or opting out, then with `restoreOperation`), `DOMAIN_DELETE` (details: name; `restoreOperation` when the domain's apex TXT set was managed), `DKIM_ROTATION_STARTED` (details: domain name, new `selector`, `reason: "scheduled" | "manual" | "compromised"`; also written when "Key compromised" is reported during a rotation, then with the rotation's new selector and `reason: "compromised"`), `DKIM_ROTATION_SWITCHED` (details: name, `selector`, `previousSelector`), `DKIM_ROTATION_RETIRED` (details: name, the retired `selector`), `DKIM_ROTATION_CANCELLED` (details: name, the abandoned `selector`; `reverted: true` when a switch the MTA hadn't confirmed was reverted), `DKIM_ROTATION_PAUSED` (details: name, `paused`; restapi step 4), `INTEGRATION_UPDATE` (details: `section`, the changed `keys`, `secretChanged`; `secretLeftBehind: true` when a secret replaced or cleared stayed in a backend the deployment no longer uses, or couldn't be removed), `INTEGRATION_RESET` (details: `section`, the `keys` that were set; `secretLeftBehind` as above), `PLUGIN_SECRET_MIGRATED`.

### 4.8 Operations and the controller's state

Two models arrive with the desired-state API (restapi step 3), Mongo and SQL, deny-all class ACL:

- **`DnsOperation`**: a one-shot operation the controller runs (`type`: `test`, `takeover` or `restore`), with `providerUid`, the `domainUid` and `endpointSetId` it concerns, the `records` it writes (TXT values unquoted), `state` (`queued`, `running`, `succeeded`, `failed`), the controller's `message`, `requestedBy`, `startedAt` and `finishedAt`. Queued by `POST system/dns-providers/:id/test` and `/:id/takeover`, by an apex TXT opt-in (takeover) and by an opt-out or the deletion of a managed domain (restore). Handed to the controller in the desired state while `queued` or `running`; a finished one is never reopened by a later report. An operation that can no longer run is marked `failed` with a message starting `Cancelled:`: a restore queued for an opt-out or a domain deletion whose own write then failed, and the queued or running operations of a provider config that is deleted (10.1).
- **`DnsControllerState`**: a singleton (`uid: "dns-controller"`) holding the controller's last `handshake` (its versions, `compatible`, `selected`, `reason`, when), the Lease holder's `lastReport` (its version, the desired-state version, the Lease holder and identity, when) and `lastStandbyReport`, the same of the last report from a pod that didn't hold the Lease (7.3), which `GET system/dns-providers/controller` serves to the console.

## 5. Secret Storage

### 5.1 Interface

restapi defines the abstraction; the server registers the implementation (DI token `"SecretStore"`), the same way `BlobStore` and `DkimKeyProvider` are split:

```ts
export interface SecretStore {
    /** "none" only for NullSecretStore: what code that can do without a store (the plugin-secret migration, 5.4) checks. */
    readonly backend: "openbao" | "kubernetes" | "none";
    /** Replaces the whole secret at `path` with `values`; returns the reference to persist. */
    write(path: string, values: Record<string, string>): Promise<SecretRef>;
    /** Merges `values` into the secret (unspecified keys kept): what a write-only form with some fields left alone sends. */
    patch(ref: SecretRef, values: Record<string, string | null>): Promise<SecretRef>;
    /** Only for secrets the server itself consumes (Giphy key, registry token, plugin secrets). DNS credentials are never
     * readable by the server (5.2). */
    read(ref: SecretRef): Promise<Record<string, string>>;
    delete(ref: SecretRef): Promise<void>;
}
```

restapi ships `NullSecretStore` (`backend: "none"`), so a deployment without one refuses to save credentials rather than storing them anywhere else. Each operation fails the way its caller needs:

- `write()` and `patch()` reject with a **400** "no secret store is configured" (`NO_SECRET_STORE_MESSAGE`), which a route saving credentials passes on.
- `read()` rejects with a **503** (`NO_SECRET_STORE_READ_MESSAGE`): the request that needed a server-side secret (a Giphy search) isn't at fault, so it isn't a 400; the consumer treats the secret as unset.
- `delete()` **resolves**: nothing was ever stored through it, and a row holding a reference from a deployment that had a store (a restored database, a redeploy without OpenBao) must still be deletable, so deleting a DNS provider or uninstalling a plugin is never blocked. A caller that wants to note that the secret was left behind compares `ref.backend` with `backend`. Every store's `delete()` resolves for a secret that is already gone.

The mask is shared with plugin settings (`src/secrets/SecretMask.ts`): `secretMask()` and `isSecretMask()` are what `maskSecretSettings()` and the plugin route use, `maskSecretRef(ref)` shows each key of a `SecretRef` as the mask, and `toSecretPatch(input, fields, multiLineFields?)` turns a write-only form's credentials into the argument of `patch()`: a string sets (surrounding whitespace, such as a pasted newline, trimmed), `null` clears, the mask or an absent field is left alone. It is a 400 for an empty or whitespace-only value, a control character inside a value (tab and line breaks allowed only in `multiLineFields`, such as Google's `serviceAccountJson`), any other value, and an unknown field. The error names the field, or for an unknown one lists the allowed fields, and never repeats anything sent, since a credential sent by mistake as a key would otherwise be reflected. `SecretRef` and `SecretBackend` live in `models/types.ts`, next to the entities that hold them.

Paths are namespaced by consumer: `dns/<provider uid>` (DNS credentials, consumed only by external-dns), `server/<name>` (Giphy key, registry token; Integrations writes each under `server/<name>-<random>`, a new path per write, 4.5) and `plugins/<package>/<key>` (plugin secrets).

### 5.2 Backends (server)

**OpenBao** (chart `global.openbao.enabled`, set by the installer):

- **Kubernetes auth only; no new long-lived tokens.** The installer enables OpenBao's `kubernetes` auth method and creates one role per consumer, each bound to exactly one ServiceAccount in the release namespace and to one narrow policy. Each consumer logs in with its projected ServiceAccount token (audience `openbao`) and renews or logs in again before its OpenBao token expires (token TTL 1 hour):

| Role | ServiceAccount | Policy |
| --- | --- | --- |
| `<fullname>-server` | server | `create`/`update`/`delete` on `kv/data/<fullname>/integrations/dns/*` (**no `read`**: the server can write DNS credentials but never read them back); `create`/`read`/`update`/`delete` on `kv/data/<fullname>/integrations/server/*` and `.../plugins/*`; `read` on the matching `metadata/` paths; the PKI `sign`/`revoke` paths the existing PKI policy grants. |
| `<fullname>-dns-controller` | dns-controller | `read` on `kv/metadata/<fullname>/integrations/dns/*` only: the current version, to roll an external-dns pod when its credentials change. No data access. |
| `<fullname>-eso` | the chart's External Secrets ServiceAccount | `read` on `kv/data/<fullname>/secrets` (as today) and on `kv/data/<fullname>/integrations/dns/*`. |

- DNS credentials therefore reach an external-dns pod only through an `ExternalSecret` the controller creates next to its Deployment; External Secrets materializes the Kubernetes Secret, as for every other release secret. Neither the server nor the controller holds them in memory after the write.
- The installer migrates the two existing periodic tokens to the same scheme: the chart's `SecretStore` switches to `auth.method: kubernetes` with the `<fullname>-eso` role, the PKI client logs in with the server role, and the old tokens and their Secrets are revoked and deleted.
- **TLS on the in-cluster listener.** The installer issues the listener certificate with cert-manager (already installed): a self-signed `Issuer` in the `openbao` namespace creates a CA, a CA `Issuer` issues `openbao-tls` for `openbao`, `openbao.openbao`, `openbao.openbao.svc`, `openbao.openbao.svc.cluster.local` and the pod's internal names. OpenBao's listener uses it (`tls_cert_file`/`tls_key_file`), and the address becomes `https://openbao.openbao.svc:8200`. The CA certificate is copied into ConfigMap `<fullname>-openbao-ca` in the release namespace; the server and controller mount it and verify the peer with it (`mail:secrets:openbao:ca_file`, `mail:pki:openbao:ca_file`), and the `SecretStore` uses it through `caProvider`.
- `assertSafeAddress()` keeps its rule (https to any host, plain HTTP only to loopback) unchanged; with TLS the in-cluster address passes, and the OpenBao clients gain only a configurable CA bundle. An external OpenBao (`OPENBAO_ADDRESS`) must be https; the installer refuses plain HTTP unless the address is loopback.

**Kubernetes Secrets** (no OpenBao):

- The server has no Kubernetes write rights (§7), so it hands the values to the controller (`PUT /secrets/:path` on the controller's internal API, 7.3), which writes them. DNS credentials go to `<fullname>-dns-<provider uid>` (mounted only by that provider's external-dns pod). Server-consumed secrets go to one Secret, `<fullname>-integration-secrets`, which the server pod mounts as files (`optional: true`); the server reads a file at use time, and the Secret carries a `generation` key so the server knows when the kubelet has refreshed the mount (usually within a minute). The server gains no Kubernetes read access to Secrets.
- Labels: `app.kubernetes.io/managed-by: rapidmx-dns-controller`, `rapidmx.io/secret-kind: <dns|server|plugins>`.

### 5.3 Rules

- **Write-only API.** No route returns a secret value. Responses carry `{ "secret": true }` per set key, exactly as `maskSecretSettings()` does today, and accept that mask back as "unchanged". `null` clears a key.
- **Never in the database**: rows hold `SecretRef` only. Never in an audit entry, a log line or an error message.
- **Hidden from Diagnostics**: every config key the integrations layer sets that holds a secret is named on `hiddenSettings.ts`'s explicit list (`giphy:api_key` and `system:plugins:registry_token` already are). The Diagnostics page shows the integrations layer as its own source, with secrets shown as "set".
- **Rotation**: a write bumps `SecretRef.generation`; the external-dns Deployment's pod template carries it as an annotation, so new credentials roll the pod.

### 5.4 Migrating plugin-setting secrets

Plugin settings that `isSecretSetting()` classifies as secrets move to the store:

- On save, a secret setting's value is written to the store at `plugins/<package name>/<key>` and the row keeps `{ "$secretRef": SecretRef }` in its place.
- On load, the plugin host resolves each `$secretRef` before putting the settings into the `plugins` nconf layer, so plugins see no change.
- A one-time, idempotent migration at server start moves existing plaintext secret values to the store and audits `PLUGIN_SECRET_MIGRATED` per key. It runs only when a real `SecretStore` is registered; otherwise plaintext stays and Diagnostics warns.
- The config-change hash (`computePluginStateHash()`) uses the reference's `generation`, not the value.
- Plugin uninstall deletes its secrets.

## 6. Records

### 6.1 Per domain

For each enabled `Domain` with `dnsProviderUid`, exactly the records `checkDnsSetup()` recommends, built by one shared function (`buildDesiredDnsRecords(domain, ctx)` in `DnsSetupUtils.ts`) that `checkDnsSetup()` is refactored to use too, so the checklist and the publication cannot drift:

| Record | Name | Type | Value |
| --- | --- | --- | --- |
| Ownership | `_rapidmx-verify.<domain>` | TXT | `rapidmx-domain-verification=<token>` (§6.5) |
| SPF | `<domain>` | TXT | **only when `apexTxt.managed`** (DECIDED, §9.4): one endpoint holding `apexTxt.spf` (`v=spf1 mx ~all`, or the existing SPF chosen at opt-in) plus every value on `apexTxt.keep`; otherwise SPF is shown as manual (`apex_txt_unmanaged`) |
| MX | `<domain>` | MX | `10 <mx host>` |
| DKIM (active) | `<dkimSelector>._domainkey.<domain>` | TXT | `v=DKIM1; k=rsa; p=<key>` |
| DKIM (next / previous) | `<selector>._domainkey.<domain>` | TXT | during a rotation only (6.2) |
| DMARC | `_dmarc.<domain>` | TXT | as recommended |
| OpenPGP WKD | `openpgpkey.<domain>` | CNAME | `<mx host>` |
| Autodiscover | `autodiscover.<domain>` | CNAME | autodiscover host, only while the plugin is active |
| Autodiscover SRV | `_autodiscover._tcp.<domain>` | SRV | `0 0 443 <autodiscover host>.`, only while the plugin is active |

Rules:

- A record whose `configured` would be false is not published (no DKIM before a key exists).
- TXT at the same name is one endpoint: external-dns manages a name and type as one record set, and once it owns a set it owns **all** of it (§9.3). That is why ownership verification has its own name (§6.5) and the apex TXT set is never touched without the admin's opt-in.
- The ownership TXT keeps being published after verification (it costs nothing and lets a re-verification work); it is removed with the domain.
- A disabled domain (`enabled: false`) keeps its records; deleting a domain removes them.
- An alias domain publishes its own full set, like any other.
- A kind the provider cannot hold (rfc2136: MX, SRV) is left out and shown as manual (`kind_unsupported`).

`DnsRecordType` gains `dkim_next` and `dkim_previous`, so the checklist shows the extra selectors during a rotation.

### 6.2 DKIM rotation

**Components.**

- **restapi**: the rotation state on `Domain`, `DkimRotationJob`, the routes, an extended `DkimKeyProvider` interface, and `FsDkimKeyProvider`'s per-domain selectors and switch (the class lives in restapi, not the server, so its rotation methods are restapi step 4; first drafted as server step 5).
- **server**: registers `DkimRotationJob` and documents its configuration.
- **postfix-bridge**: `dkim-sync.sh` signs each domain with its own selector and acknowledges the switch.

**Selectors.** Each rotation mints a new selector `rmx<yyyymmdd>` (suffix `b`, `c`, ... on a same-day collision). An existing domain keeps the global selector (`mail`) until its first rotation.

**`DkimKeyProvider` additions** (optional methods; `supportsRotation` false on `NullDkimKeyProvider`):

```ts
interface DkimKeyProvider {
    ensureKeyPair(domain: string): Promise<DkimKeyPair | undefined>;   // unchanged
    readonly supportsRotation?: boolean;
    /** Creates the key for `selector` without signing with it. Idempotent (exclusive create, as ensureKeyPair is). */
    generateKeyPair?(domain: string, selector: string): Promise<DkimKeyPair>;
    /** The key `selector` has, without creating one (added in restapi step 4): what tells a provider-made key from an imported one on rows from
     * before `dkimManaged`. */
    findKeyPair?(domain: string, selector: string): Promise<DkimKeyPair | undefined>;
    /** Makes `selector` the one the MTA signs `domain` with. */
    activate?(domain: string, selector: string): Promise<void>;
    /** The selector the MTA reports it is signing `domain` with, if it reports one. */
    signingSelector?(domain: string): Promise<string | undefined>;
    /** Deletes the private key of a retired selector. */
    deleteKeyPair?(domain: string, selector: string): Promise<void>;
}
```

**Files on the shared DKIM volume** (`FsDkimKeyProvider`, restapi):

- `<domain>.<selector>.key`: one per selector, as today's naming already allows.
- `<domain>.selector`: the selector to sign with, written atomically (temp file + rename) by `activate()`. Its absence means the global selector, so existing deployments are unaffected until a rotation.
- `<domain>.signing`: written by postfix-bridge after OpenDKIM has reloaded with a selector, containing that selector. `signingSelector()` reads it.
- As implemented: `ensureKeyPair()` returns the key of the selector in `<domain>.selector` (the global one without it), `activate()` refuses a selector without a key, `deleteKeyPair()` refuses the selector signing uses and resolves for a key already gone, a selector must be one lowercase DNS label, and a new key has `mail:dkim:rotation:key_bits` bits: a whole number from 2048 to 4096 (or its text), else 2048 with a warning, for every new key, not only rotations. Keys are generated asynchronously (`crypto.generateKeyPair`, on libuv's thread pool), never blocking the event loop.

**postfix-bridge `dkim-sync.sh`** (and the init container): per domain, use `<domain>.selector` when present, else `$DKIM_SELECTOR`; copy `<domain>.<sel>.key` to `/etc/opendkim/keys/<domain>.<sel>.private`; write `KeyTable` lines `<sel>._domainkey.<d> <d>:<sel>:<path>` and `SigningTable` `*@<d> <sel>._domainkey.<d>`; after a successful `SIGUSR1` reload, write `<domain>.signing`. Old `<domain>.private` files are removed once a per-selector file exists. The bundled `postfixBridge` subchart moves in lock-step with the server chart. docker-compose (`server/docker-compose.mail.yml`) uses the same script.

**State** (`Domain.dkimRotation`):

```ts
interface DkimRotationState {
    phase: "idle" | "pending" | "switching" | "overlap";
    next?: { selector: string; publicKey: string; createdAt: Date; liveSince?: Date; reason: "scheduled" | "manual" | "compromised" };
    previous?: { selector: string; publicKey: string; retireAt?: Date };
    reason?: "scheduled" | "manual" | "compromised";   // restapi step 4: the switched rotation's reason, kept until it retires
    switchedAt?: Date;                                  // restapi step 4: when signing switched; the acknowledgement hour counts from it
    lastRotatedAt?: Date;
    lastCancelledAt?: Date;                             // restapi step 4: the interval counts from it too
    paused?: boolean;
    mintedSelectors?: string[];                         // restapi step 4: the selectors minted on the latest start's UTC day, never minted again
    lastError?: string;
}
```

**Phases**, driven by `DkimRotationJob` (`mail:jobs:dkim_rotation:schedule`, default hourly). It runs on every replica; each transition is one versioned update of the domain row, so a replica that loses the race skips:

1. **idle → pending.** Triggered when `lastRotatedAt` (or the key's creation) is older than `mail:dkim:rotation:interval_days` (default 180), or by "Rotate now". The job records `next.selector` in the row first, then calls `generateKeyPair()`. The new record `dkim_next` joins the desired state: published by the provider, or shown in the console for the admin to add ("Publish this record to finish rotating"). Signing is unchanged.
2. **pending → switching.** The job live-checks `next.selector._domainkey.<domain>` through the configured `DnsResolver`. When it matches, it sets `liveSince`. When `liveSince` is at least `mail:dkim:rotation:publish_grace_hours` old (default 48, so receivers' resolvers have dropped any negative-cached answer), it calls `activate()`, sets `dkimSelector`/`dkimPublicKey` to the new key, and moves the old one to `previous`. **A manual domain follows exactly the same rule: signing never switches before the live check passes**, however long the admin takes. The console reminds the admin after 7 days.
3. **switching → overlap.** When `signingSelector()` reports the new selector (postfix-bridge has reloaded), the job sets `previous.retireAt = now + mail:dkim:rotation:overlap_days` (default 7), so mail signed with the old key and still in queues, or re-verified later, keeps verifying. If no acknowledgement arrives within an hour (an older postfix-bridge without the acknowledgement), the job records `lastError`, keeps both selectors published, and does not start the overlap clock.
4. **overlap → idle.** At `retireAt` the old selector's record leaves the desired state (the provider deletes it; a manual domain's console says the admin may now remove it), `deleteKeyPair()` removes the old private key, and `lastRotatedAt` is set.

**Manual action.** `POST mail/domains/:id/dkim/rotate` with `{ compromised?: boolean }` (trusted role and elevation, audited) starts phase 1 now. With `compromised`, the publish grace is skipped (the switch still waits for the live check, since switching earlier makes every message fail DKIM) and the overlap is zero: the old record is removed as soon as signing is confirmed. `POST mail/domains/:id/dkim/rotation/cancel` abandons a rotation whose switch the MTA has not confirmed (deletes the new key and its record; a switch not yet acknowledged is reverted, see below). `PUT mail/domains/:id/dkim/rotation` with `{ paused }` stops scheduled rotation for one domain.

**Not rotated:** domains whose key was imported by hand (`dkimManaged: false`), deployments whose provider does not support rotation (`NullDkimKeyProvider`), and SES deployments (SES's Easy DKIM rotates its own keys). The console says why.

**As implemented (restapi step 4).**

- `DkimRotationJob` (`DkimRotationJobMongo`/`DkimRotationJobSQL`, schedule `mail:jobs:dkim_rotation:schedule`, default `0 0 * * * *`) reads every domain page by page and moves each through as many phases as are due (at most five per run, so a compromised key goes from live through the switch to retired in one run once the MTA has confirmed). A version conflict (another replica, an admin's cancel) is logged at debug level and the domain is looked at again next run; any other failure is a warning and the other domains go on. It does nothing while the provider doesn't rotate or `mail:transport:provider` is `ses`. A provider rotates only with `supportsRotation`, `generateKeyPair()`, `activate()` and `signingSelector()`: without the acknowledgement a switch could never be confirmed.
- **Scheduled starts** need `mail:dkim:rotation:enabled` (the text `false`, `0`, `no`, `off` too turn it off), an enabled and verified domain with a key (nobody may ever publish an unverified domain's new record), no pause, and `interval_days` since the latest of `lastRotatedAt` and `lastCancelledAt`, or since the domain's creation before either. At most `mail:dkim:rotation:max_starts_per_run` (default 10) start per run and replica, so the first run after rotation arrives, when every older domain is due at once, spreads the new keys and records over several runs. With `enabled` off, "Rotate now" still works and a rotation in progress still finishes. A row from before `dkimManaged` is classified first (`findKeyPair()`): a key the provider doesn't hold is recorded as imported and never rotated; a provider without `findKeyPair()` leaves such rows alone.
- **Start:** the new selector (`rmx<yyyymmdd>`, then `b`, `c`, ... `z`, `aa`, ... past the current, previous and next selectors and every selector minted earlier that UTC day, `mintedSelectors`, since a receiver may still cache a cancelled or retired one's record) is recorded with `publicKey: ""`, audited, then generated; a key that can't be generated is kept as `lastError` and retried by the next run. A `next` without a public key is never published. When recording the generated key loses a race (a cancel, another replica), the key is deleted unless the row that won names its selector, so no private key is left behind.
- **pending:** the live check is any TXT at `<selector>._domainkey.<domain>` whose rejoined strings, without spaces, carry `p=<key>`; a record that disappears clears `liveSince`, so the grace starts over.
- **Switch:** one versioned update first sets `dkimSelector`/`dkimPublicKey` to the new key, `previous` to the old one, `reason` and `switchedAt` (so a cancel racing it loses), audited and announced; `activate()` is then called on every run until `signingSelector()` reports the new selector. A failing `activate()`, or no acknowledgement an hour after `switchedAt`, is `lastError`, written only when it changes and cleared once the switch is confirmed. After each `activate()` the job reads the row again and, when a cancel has reverted the switch meanwhile, activates the row's selector instead.
- **Retire:** the row goes back to idle (keeping `lastCancelledAt`, `paused` and `mintedSelectors`) with `lastRotatedAt`, then `deleteKeyPair()` removes the old key; a key that can't be deleted is logged and left.
- **Routes** (`mail/domains`), all trusted-role, the writes with elevation, a 409 for a domain whose key can't rotate (with the reason) or a rotation in the wrong phase:
  - `GET /:id/dkim/rotation` answers `{ rotation, rotatable, blocker?, nextScheduledAt? }`, `blocker` being `unsupported`, `ses`, `no_key`, `imported` or `unknown_key`; `nextScheduledAt` only while the job would start one (idle, not paused, enabled and verified, scheduled rotation on). It writes nothing.
  - `POST /:id/dkim/rotate` `{ compromised?: boolean }` starts a rotation (`reason: "manual"` or `"compromised"`) and answers the domain with `next` filled in. During a rotation, `compromised: true` means the key being rotated away is compromised (audited again as `DKIM_ROTATION_STARTED`): a pending rotation skips the grace, a switching one gets no overlap (the old record goes as soon as the MTA confirms), and an overlap is retired at once (old record and key). A rotation already treating the key as compromised, or any other rotate during a rotation, is a 409.
  - `POST /:id/dkim/rotation/cancel` abandons a rotation the MTA hasn't confirmed (sets `lastCancelledAt`, deletes the new key, audited, announced) and changes nothing without one. A pending rotation simply ends. A switching one is **reverted**, the way out of a switch the MTA never acknowledges: the provider signs with the old key again (refused with 503, changing nothing, when it can't; 409 when the old key is gone), then one versioned update puts `dkimSelector`/`dkimPublicKey` back to `previous` (a job confirming the switch at the same time wins, and the provider is pointed back at the row's selector), then the old key is activated once more; audited with `reverted: true`. An overlap is a 409: it finishes on its own.
  - `PUT /:id/dkim/rotation` `{ paused: boolean }` pauses or resumes scheduled rotation (audited `DKIM_ROTATION_PAUSED`); a rotation in progress still finishes.
- A `PUT` changing `dkimSelector` or `dkimPublicKey` is a 409 while a rotation is in progress, and records `dkimManaged: false` otherwise. `dkimManaged` is server-managed like `dkimRotation`.

**Config:** `mail:dkim:rotation:enabled` (default true), `interval_days` (180), `overlap_days` (7), `publish_grace_hours` (48), `key_bits` (2048), `max_starts_per_run` (10, restapi step 4). These are deployment config, not Integrations.

### 6.3 The deployment's own hosts

Published through the provider config whose `zones` cover each host name:

| Host | Type | Value |
| --- | --- | --- |
| `mail.<global.domain>` (the chart's mail host, `mail:dns:mx_hostname`) | A / AAAA | the deployment's public addresses (6.4) |
| `auth.<global.domain>` | CNAME | mail host |
| `autodiscover.<global.domain>` | CNAME | mail host (when the autodiscover plugin is active) |
| `openpgpkey.<global.domain>` | CNAME | mail host (when the openpgpkey host is on, 12.5) |

A host that a domain's endpoint set already publishes (the deployment's own domain publishes `openpgpkey.<domain>` and `autodiscover.<domain>` itself, 6.1) is left out of the hosts' sets, and so is any host record that would put a CNAME next to another record a domain publishes at that name: two `DNSEndpoint`s claiming one name and type would make its ownership record flip between them, could set two external-dns instances against each other, and deleting the domain would delete a record the hosts still want. Once no domain publishes it, the hosts' set does.

The host list is not hard-coded in the server: the chart renders it into `mail:dns:publish:hosts` (JSON list of `{ name, type: "address" | "cname", target? }`), from the same values that render the Gateway listeners and Certificates, so a host is published exactly when the chart serves it. **A host outside every provider's zones stays manual** (`manualReason: "outside_zones"`) and is marked so in the console and in the installer's final message.

### 6.4 Public addresses

The A/AAAA targets come from `mail:dns:publish:addresses` (JSON list of IPv4/IPv6 literals), which the chart takes from `dns.publicAddresses`. The installer detects them: the node's global unicast addresses (`ip -j addr`), and, when the node has only private addresses (NAT, cloud), the address seen from outside, the way coturn's `detect-external-ip` does. It prints what it found, and `--public-address <ip>` (repeatable) overrides detection. The server validates the list (global unicast only; private, loopback, link-local and CGNAT ranges refused) and publishes nothing for the hosts while it is empty, saying so in the console.

### 6.5 Ownership verification name (DECIDED)

**Decided by JP (2026-10-27):** the ownership TXT moves from the apex to a dedicated name, `_rapidmx-verify.<domain>`, so RapidMX never takes over a domain's apex TXT set to verify it. The takeover spike (§9.3) showed that owning a set means owning every value in it, so publishing the token at the apex would have put every site-verification and SPF value of every domain under RapidMX's control.

- **Value unchanged:** `rapidmx-domain-verification=<verificationToken>` (`buildVerificationTxtValue()`), only the name changes. A new helper `buildVerificationRecordName(domain)` returns `_rapidmx-verify.<domain>`; `DOMAIN_VERIFICATION_RECORD_LABEL = "_rapidmx-verify"`.
- **Recommended and published: only the new name.** `checkDnsSetup()`'s `ownership` row and `buildDesiredDnsRecords()` both use `_rapidmx-verify.<domain>`. The label starts with `_`, so it can never collide with a host name and needs no CNAME exception.
- **Migration: both locations are accepted during a transition.** `findDomainVerification()` resolves `_rapidmx-verify.<domain>` and the apex at once and verifies on an exact token match at the record, or at the apex while `mail:domain_verification:accept_legacy_apex` is true (default true; `false`, `0` and the text `false`, `0`, `no` or `off`, as an environment variable sets it, turn it off: `acceptsLegacyApex()`). The result says where it was found (`location: "record" | "legacy_apex"`, plus `atRecord`/`atLegacyApex`), and `DOMAIN_VERIFIED`'s audit details carry it. `checkDomainVerification()` keeps its boolean answer for existing callers. **The key is not `mail:domains:verification:...` as first drafted:** `mail:domains` becomes the list of seeded domains (§13), and a list can't also hold a nested key.
- **Console:** an unverified domain whose token is found only at the apex is verified as today, and its `ownership` row says "Found at the domain's root (the old location). Publish it at `_rapidmx-verify.<domain>`; the root value can then be removed." A verified domain stays verified (`verified` never flips back), so existing domains need no action; the hint about removing the old apex value is shown while it is still present.
- **Ending the transition:** the default of `mail:domain_verification:accept_legacy_apex` flips to false in a later minor release, announced in the release notes one release ahead. Only unverified domains are affected by the flip.
- **Takeover interaction:** when an admin opts a domain into apex TXT management (§9.4), any `rapidmx-domain-verification=` value at the apex is **not** carried into `apexTxt.keep`; it is dropped, since verification no longer reads it there once the domain is verified.
- Tests (restapi): verification at the new name, at the legacy apex with the flag on, refused at the legacy apex with it off, chunked TXT at both, NXDOMAIN at one location and a match at the other, the `location` reported, and the checklist recommending only the new name.

## 7. The DNS Controller

### 7.1 Why a separate pod

Creating Deployments, Secrets and Jobs is a namespace-admin-like right: whoever holds it can run arbitrary pods in the namespace. The mail server is the large, internet-facing process. It therefore keeps **only its existing read-only Kubernetes access** (the Diagnostics Role) and records desired state; a small controller holds the write rights and nothing else (no database, no Redis, no plugins, no mail).

### 7.2 A dedicated project: `rapidmx/dns-controller`

**Decided by JP (2026-10-27):** the controller is its own project, repository `rapidmx/dns-controller` (`D:/github/rapidmx/dns-controller`), published as the container image `ghcr.io/rapidmx/dns-controller:<version>`. It is **not** the server image with another command: an image that holds the whole mail server (its routes, datastore drivers, plugin host and every dependency of them) in the one pod that can create Deployments, Secrets and Jobs would defeat the point of a separate controller. It follows how `postfix-bridge`, `ses-bridge` and `acme` are separate repositories.

**Runtime.**

- TypeScript on Node.js 24, like `postfix-bridge` (the closest sibling: a small, standalone Node service with one job). Built with `tsc`, linted and tested with the siblings' eslint and vitest setup, 100 % coverage thresholds.
- **No runtime dependencies.** Kubernetes REST through `node:https` with the pod's ServiceAccount token (re-read on every request; bound tokens rotate) and the cluster CA from the ServiceAccount mount, as the server's `KubeClient` does. Not `@kubernetes/client-node` (a large dependency tree in the most privileged pod, for a handful of verbs on six resource types). Not the global `fetch` for Kubernetes either: `fetch` cannot take a per-request CA without the `undici` package's dispatcher, and `NODE_EXTRA_CA_CERTS` would make the cluster CA trusted for every outbound call the process makes; `node:https` keeps the cluster CA scoped to the API server. The server's internal API is called with the global `fetch`. JWT verification (7.3) uses `node:crypto` (JWK import, RS256/ES256), logging is a small JSON-lines logger, and the health and internal endpoints are `node:http`.
- **Image:** multi-stage; built on `node:24-trixie-slim`, shipped on `gcr.io/distroless/nodejs24-debian13:nonroot` (Node only: no shell, no package manager, uid 65532), containing only `dist/` and `package.json`. The pod runs non-root with a read-only root filesystem, all capabilities dropped, `RuntimeDefault` seccomp and `allowPrivilegeEscalation: false`; it writes nothing to disk.
- **Phases of the controller project** (each a reviewed, tested commit series in that repository):
  - **C1 skeleton** (scaffolded 2026-10-27, not yet released): configuration from the environment, JSON logging, `/healthz` and `/readyz`, the Kubernetes REST client, the Lease-based single writer, the versioned API types and the startup handshake (7.3). No reconcile logic.
  - **C2 auth and secrets:** projected-token verification of the server's calls against the in-cluster JWKS, the controller's own projected token on its calls, `PUT`/`DELETE /v1/secrets/:path` (Kubernetes-Secret backend, 5.2).
  - **C3 reconcile:** the desired-state long poll, manifests (external-dns Deployments, `DNSEndpoint`s, `ExternalSecret`s) with server-side apply, image-pin enforcement, status reports.
  - **C4 operations:** the takeover, test and restore Jobs (§9).
  - **C5 health:** external-dns metrics scraping and per-provider health in the status report.

**Packaging: a plain image the server chart templates, not a subchart** (recommended). `postfix-bridge` is a subchart because it is a product of its own: it runs its own Postfix, is documented to run without the server chart, and its values make sense alone. The controller has no standalone use. Everything it is configured with derives from the server release: the desired-state URL, the server's ServiceAccount subject it accepts calls from, the token audiences, the Lease and resource names (`<fullname>-...`), the external-dns ServiceAccount and Role, the OpenBao role, the NetworkPolicy selecting the server pods. A subchart would need all of that passed down through `global` values, and the controller's Role, the most security-sensitive object in the release, would live in another repository, outside the server chart's `helm template` tests (server Role has no write verbs; controller Role is namespaced and minimal). So the controller repository publishes **only the image** (its publish job mirrors `postfix-bridge`'s `publish-docker-image`, without the chart job), and the server chart owns its templates: `helm/templates/1_deployments/dns-controller.yaml` (Deployment, Service), `0_config/dns-controller-rbac.yaml` (ServiceAccount, Role, RoleBinding, and the external-dns ServiceAccount/Role of 7.4), `2_services/dns-controller-networkpolicy.yaml`. The Lease is not templated: the controller creates it.

**Version pin, lock-step.** The server chart pins the controller image to an exact released version, `dns.controller.image.tag` (and optionally `digest`), the way it pins `postfix-bridge` through its `Chart.yaml` dependency version. Releasing a server version that needs a controller change means releasing the controller first and moving the pin in a reviewed commit, edited by YAML key path, never by matching version text. The API handshake (7.3) catches an override that pairs incompatible versions.

**Deployment shape** (rendered when `dns.publishing.enabled`): `replicas: 1` (not configurable), `strategy: Recreate`, its own ServiceAccount `<fullname>-dns-controller` with a projected token volume for the audience `rapidmx-internal-dns` (in addition to the default token used for the Kubernetes API), small requests/limits, a ClusterIP Service exposing port 8080 (internal API) to the server, health on port 8081, and a NetworkPolicy admitting only the server pods on 8080.

**Single writer.** One replica with `Recreate`, plus a `coordination.k8s.io/v1` `Lease` (`<fullname>-dns-controller`, renewed every 10 s, 30 s duration) that the controller must hold before writing, so a stuck old pod and a new one can never write together. Expiry is judged the way client-go's leader election does: by the local time at which this process last saw the Lease record change, not by comparing `renewTime` with its own clock, so clock skew between nodes cannot make two holders. A controller that fails to renew before the duration elapses stops writing at once.

### 7.3 How it gets desired state: a versioned internal API on the server

The controller reads desired state **through the server's internal API**, not from the database:

- **Least privilege.** A database connection would give the pod that can run arbitrary pods read access to every mailbox. The API gives it exactly the desired state.
- **One source of record-building logic.** `buildDesiredDnsRecords()`, assignment rules and the rotation state stay in restapi and the server; the controller only turns desired state into manifests.
- Both backends (Mongo, SQL) work without the controller knowing either.

**Versioning.** The controller and the server ship from different repositories, so their contract is explicitly versioned:

- Every route is under a version path, `/internal/dns/v1/...`, and **every payload, request and response, carries `apiVersion: "dns.rapidmx.io/v1"` and a `kind`**. A receiver refuses a payload whose `apiVersion` it does not speak (`400 { "reason": "unsupported_api_version", "supported": [...] }`) and never guesses.
- Within `v1`, changes are additive only: new optional fields, new `kind`s, new routes. Receivers ignore unknown fields. A breaking change is `v2`, under `/internal/dns/v2`, and the server serves the previous version as well for at least one release, so either side can be upgraded first.
- The types live in the controller repository (`src/api/v1.ts`) and are mirrored in restapi (`src/dns/DnsDesiredStateApiV1.ts`); a contract test in each repository checks the same recorded JSON fixtures.

**Startup handshake.** Before it does anything else, and again every 60 s while it is incompatible, the controller calls the one route whose shape never changes:

| Route | Body | Answer |
| --- | --- | --- |
| `POST /internal/dns/handshake` (unversioned on purpose) | `{ kind: "Handshake", controllerVersion, apiVersions: ["dns.rapidmx.io/v1"] }` | `{ kind: "HandshakeResult", serverVersion, apiVersions: [...], selected?: "dns.rapidmx.io/v1", compatible: boolean, reason? }` |

- The server picks the highest version both list. With none in common it answers `compatible: false` with the reason, and **records the controller's report** (versions, the reason, the time) so the console's DNS providers page and Diagnostics show, for example, "DNS controller 0.4.0 speaks dns.rapidmx.io/v2; this server speaks v1. Install matching versions."
- An incompatible controller **refuses to act**: it does not take the Lease, writes nothing to Kubernetes, serves no secret writes, logs `dns_api_incompatible` at error level, reports not ready on `/readyz` (visible in `kubectl get pods` and in Diagnostics), and retries the handshake every 60 s, since a rolling upgrade of the other side may fix it. A server that cannot be reached is not a mismatch: the controller keeps retrying with backoff and stays ready.
- The controller sends its `apiVersion` on every later call, and the server re-checks it, so a server rolled back underneath a running controller is caught on the next call, which sends the controller back to the handshake.

Routes (restapi `BaseDnsDesiredStateRoute`, mounted by the server under `/internal/dns`, outside the public Gateway like `/internal/mta`; the `v1` types are mirrored in `src/dns/DnsDesiredStateApiV1.ts`, and `test/fixtures/dns-api/v1/*.json` are byte-identical copies of the controller's `test/fixtures/api/v1/*.json`):

| Route | Purpose |
| --- | --- |
| `POST /internal/dns/handshake` | Above. |
| `GET /internal/dns/v1/desired-state?since=<version>` | `kind: "DesiredState"`: provider configs (with `SecretRef`s, never values), endpoints per domain and for the hosts, the owner id, the image pin, and queued operations (test, takeover, restore). With `since`, a long poll that answers when the version moves past it, or after 55 s. |
| `PUT /internal/dns/v1/status` | `kind: "StatusReport"`: per provider (Deployment readiness, metrics, last error), per endpoint (applied generation, `observedGeneration`), per operation (result), and the controller's Lease state. Answered `{ apiVersion, kind: "StatusReportResult" }`. |

As implemented in restapi step 3:

- **Authentication** goes through an injected `DnsControllerTokenVerifier` (DI token `"DnsControllerTokenVerifier"`, `verify(token) -> { subject }`), which the server implements against the in-cluster JWKS (signature, issuer, audience, expiry); the route then compares the subject, exactly, with `mail:dns:controller:subject`. No verifier registered, no subject configured, no `Authorization: Bearer` token, an invalid token or another subject are all the same 403. A user's JWT is never accepted.
- **Refusals** are `400 { reason: "unsupported_api_version", supported: [...] }` for another `apiVersion` or `kind`, and `400 { reason: "invalid_payload", message }` for a malformed handshake, status report or `since` (the message names the field, never a value). A status report is validated whole before anything is stored; unknown fields are dropped and messages cut to 2000 characters.
- **`GET` carries its version in the path** (`/v1/...`); a server rolled back to one without `/v1` answers 404, which sends the controller back to the handshake.
- **Long poll:** `DnsPublisher.version()` is read before the rows; while it equals `since` the route waits on `DnsPublisher.waitForChange(since, mail:dns:desired_state:long_poll_seconds * 1000, signal)` (default 55), the signal aborting when the controller goes away. A version **behind** `since` (the counter was reset: Redis restarted without persistence, a rebuilt server) is answered at once, so the controller learns the new count instead of waiting out every poll; the controller must therefore treat any version other than its own as a change, not only a higher one.
- **Only the Lease holder's report acts** (`lease.holder: true`): it alone updates providers, endpoints, operations and `lastReport`. A report from a pod without the Lease (a stuck old pod during a rollout, a new one waiting for the Lease) is answered the same way and recorded only as `lastStandbyReport`, so two reporters can't flip a provider's status back and forth or bump row versions under the admin's edits.
- **Status writes** happen only on change: a provider's `status` when something but `reportedAt` changed, or every 5 minutes otherwise; a domain's `dnsPublication.endpoints` only when the reported endpoint differs; so a report every minute doesn't race the admin's versioned edits. A write that loses a race is logged and the next report carries the same news. Entries naming a config, endpoint set or operation that no longer exists are ignored.
- **List-valued options** (`string[]`: Cloudflare's `zoneIds`, rfc2136's `hosts`) are in both copies of `DnsProviderV1.options` and in the shared desired-state fixture (`zoneIds` as a list, the wire shape every Cloudflare config has), changed in both repositories together. **Additive to the controller's copy**, which it adopts with phase C3: the `StatusReportResult` kind.
- **Configuration** the route reads: `mail:dns:controller:subject`, `mail:dns:desired_state:long_poll_seconds`, `mail:dns:publish:ttl` (300; raised to 120 for Cloudflare), `mail:dns:publish:hosts` and `mail:dns:publish:addresses` (lists, or their JSON strings; invalid entries and non-global addresses are logged once and left out), `mail:dns:publish:external_dns_image` (default `registry.k8s.io/external-dns/external-dns:v0.23.0`), `mail:dns:mx_hostname`, `mail:autodiscover:public_url`.
- **Desired-state contents:** every provider config (disabled ones too), one endpoint set per domain published through an existing config covering it (disabled domains too; a set with no publishable record is left out), the hosts' sets without the records a domain's set already publishes (6.3) (each host through the config whose zones cover it most specifically; `address` hosts get A and AAAA records for the global unicast addresses; a `cname` host points at its `target`, else the mail host; a host no config covers, an address host without addresses and a CNAME without a target stay manual), and the operations still `queued` or `running`.

In the other direction, the controller serves `PUT /v1/secrets/:path` and `DELETE /v1/secrets/:path` on its Service, with the same `apiVersion` rules, used only for the Kubernetes-Secret backend (5.2).

**Authentication: projected ServiceAccount tokens, no shared secrets.** Each side presents a projected ServiceAccount token with a dedicated audience (controller to server: `rapidmx-internal-dns`; server to controller: `rapidmx-dns-controller`; 1 hour, rotated by the kubelet, re-read from the file on every call). The receiver verifies the signature against the cluster's service-account issuer keys, the issuer, the audience, the expiry, and the exact subject (`system:serviceaccount:<namespace>:<fullname>-dns-controller`, or the server's). Keys are cached and refetched on an unknown `kid` (at most once a minute). No TokenReview (it would need a ClusterRole) and no long-lived secret.

- **The keys are fetched in-cluster:** `GET https://kubernetes.default.svc/openid/v1/jwks` (and the issuer from `/.well-known/openid-configuration` on the same host), authenticated with the pod's own ServiceAccount token and verified with the cluster CA. The `jwks_uri` the discovery document advertises is **not** used: on k3s it is the node's public address on port 6443, which a pod may not be able to reach and which the in-cluster certificate name does not cover.
- **Checked on powerlevel.gg's k3s v1.36.4 (2026-10-27):** the default `system:service-account-issuer-discovery` ClusterRoleBinding exists and grants every ServiceAccount (`system:serviceaccounts`) read access to `/openid/v1/jwks` and the discovery document, so neither side needs extra RBAC. On other distributions the installer checks for the binding and reports it missing instead of failing later.

Reconcile triggers on the server side only bump the desired-state version, which ends the controller's long poll:

| Trigger | Scope |
| --- | --- |
| `Domain` create, update (`enabled`, `dmarcPolicy`, `dmarcReportEmail`, `aliasOf`, DKIM fields), delete | that domain |
| `dnsProviderUid` assignment | that domain, old and new provider |
| DKIM key created or backfilled; every DKIM rotation phase change | that domain |
| Autodiscover plugin enabled/disabled, `mail:autodiscover:public_url` change | all domains |
| `DnsProvider` create, update, credentials change, enable/disable, delete | that provider |
| Takeover or test requested | queued operation |

restapi raises these through an injected `DnsPublisher` (DI token, `NullDnsPublisher` by default, so restapi alone and a non-Kubernetes deployment behave as today); the server's implementation bumps the version (a counter in Redis, so every replica answers long polls consistently). The controller also does a full reconcile on start and every 10 minutes (`dns.controller.resyncMinutes`).

As implemented: `DnsPublisher` has `changed(change)`, `version()` and `waitForChange(since, timeoutMs, signal?)`; a change is `{ scope: "domain" | "provider" | "operation" | "all", ... }`. Every caller has already saved its change, so `notifyDnsPublisher()` logs a failure instead of failing the request. The routes resolve the publisher tolerantly (`resolveDnsPublisher()`): a server that registers none gets `NullDnsPublisher` with a warning instead of failing to boot. The domain route announces a create, a delete, an update that changes `enabled`, `dmarcPolicy`, `dmarcReportEmail`, `aliasOf` or the DKIM fields, an assignment, a DKIM backfill and every apex TXT change; the provider route every create, update (also a credentials change whose row write then failed) and delete, and every queued operation. The Autodiscover plugin being enabled or disabled is picked up by the controller's periodic resync until the server announces it (server step 4).

### 7.4 The external-dns Deployment

- Created by the controller per provider config: name `<fullname>-external-dns-<provider uid>`; labels `app.kubernetes.io/name: external-dns`, `app.kubernetes.io/instance: <release>`, `app.kubernetes.io/managed-by: rapidmx-dns-controller`, `rapidmx.io/dns-provider: <provider uid>`.
- **Image pinned**: `registry.k8s.io/external-dns/external-dns:v0.23.0` (released 2026-09-18; tag confirmed on registry.k8s.io), pulled by digest, from `dns.externalDns.image`. The controller refuses any other image than the configured pin. v0.24.0 adds admission validation of `DNSEndpoint` and is not adopted now; moving to it means re-applying the CRD.
- `replicas: 1` (0 when the provider config is disabled), `strategy: Recreate`: external-dns has no leader election, and two instances with one owner id would fight.
- ServiceAccount `<fullname>-external-dns` (created by the chart, shared by all instances), bound to a Role allowing only `get`/`list`/`watch` on `dnsendpoints` and `update` on `dnsendpoints/status`. This matches external-dns's own chart with `namespaced: true`; a crd-only source needs no `nodes` or `namespaces` access.
- Probes on `/healthz`, port 7979. Hardened like the controller.
- Arguments:

```
--source=crd
--crd-source-apiversion=externaldns.k8s.io/v1alpha1
--crd-source-kind=DNSEndpoint
--namespace=<release namespace>
--label-filter=rapidmx.io/dns-provider=<provider uid>
--provider=<type>
--domain-filter=<zone>            (one per DnsProvider.zones entry)
--registry=txt
--txt-owner-id=rapidmx-<installationId>
--txt-prefix=rmx-%{record_type}.
--managed-record-types=A --managed-record-types=AAAA --managed-record-types=CNAME
--managed-record-types=MX --managed-record-types=TXT --managed-record-types=SRV
--policy=sync
--interval=1m
--events
--log-format=json
--metrics-address=:7979
<provider-specific flags from DnsProvider.options>
```

- `--policy` has no default since v0.22.0. `--managed-record-types` defaults to A, AAAA and CNAME, so MX, TXT and SRV are listed (MX and SRV are left out for rfc2136).
- `--txt-owner-id` is per deployment (`DeploymentIdentity.installationId`, 4.6), so two deployments sharing a zone never claim each other's records. It never changes.
- `--txt-prefix` with `%{record_type}` and a trailing `.` is required: without it the ownership record for an apex record (`mx-example.com`) falls outside the zone, and the registry's TXT cannot sit next to a CNAME. The MX at `example.com` is owned by a TXT at `rmx-mx.example.com`. The prefix never changes.
- Credentials come only from the Secret (env `valueFrom.secretKeyRef` or a mounted file), never as arguments.

### 7.5 `DNSEndpoint` resources

- One `DNSEndpoint` per domain (`<fullname>-domain-<domain uid with dots as hyphens>`) holding all of its records, and one for the hosts (`<fullname>-hosts-<provider uid>`). The desired state names them by endpoint set id (`domain-example-com`, `hosts-<provider uid>`), which the controller prefixes. A domain name with a hyphen of its own gets an 8-character hash of the name appended (`a-b.example.com` and `a.b-example.com` would otherwise share an id), and so does one over 180 characters (cut first).
- Labels: `rapidmx.io/dns-provider: <provider uid>` (what `--label-filter` selects), `rapidmx.io/domain: <domain uid>`, `app.kubernetes.io/managed-by: rapidmx-dns-controller`, `app.kubernetes.io/instance: <release>`.
- Reassigning a domain to another provider rewrites the label: the old instance deletes the records it owns (sync policy), the new one creates them. The console warns that this briefly removes them.
- `spec.endpoints[]`: `dnsName`, `recordType`, `targets` (TXT targets quoted, 4.2), `recordTTL` (`mail:dns:publish:ttl`, default 300; Cloudflare needs at least 120), and `providerSpecific` only where needed (Cloudflare `cloudflare/proxied: "false"` on A/AAAA/CNAME). The registry's own ownership TXT records carry no TTL (9.3).
- Writes use server-side apply (`fieldManager=rapidmx-dns-controller`), so every write is idempotent. The controller's own Kubernetes client (in its repository, 7.2) has `GET`, `POST`, `PUT`, apply `PATCH` and `DELETE`; the server's `KubeClient` stays GET-only.
- `status.observedGeneration` is written by external-dns when it **reads** the resource, not when the provider has applied it. "Published" therefore means observed **and** seen by the server's live check. Observed but not live is "pending"; still not live after several intervals is shown with the instance's last error.

Deletion: a deleted domain's endpoint is deleted; external-dns removes what it owns on its next sync, and a managed apex TXT set is restored afterwards (9.5). A provider config can be deleted only when no domain is assigned to it and no `restore` operation of it is queued or running (409 otherwise: a restore runs only with that config's credentials, so deleting it first would lose the kept values); its other queued or running operations are cancelled (4.8). The server removes the row and then its credentials from the secret store (the running instance keeps the copy it started with; a store failure, or a reference from a backend the deployment no longer has, leaves them behind, logged and audited as `secretLeftBehind`); the controller then deletes its hosts endpoint, waits one interval, and deletes the Deployment and its Kubernetes Secret.

### 7.6 RBAC

The server's Role is unchanged (read-only Diagnostics access). The controller's Role `<fullname>-dns-controller`, in the release namespace only:

| apiGroups | resources | verbs |
| --- | --- | --- |
| `apps` | `deployments` | get, list, watch, create, update, patch, delete |
| `""` | `secrets` | create; get, update, patch, delete restricted by `resourceNames` where the name is fixed (`<fullname>-integration-secrets`); the per-provider Secrets are checked by label before any change |
| `""` | `pods` | get, list (to find external-dns pods for metrics) |
| `batch` | `jobs` | get, list, create, delete |
| `externaldns.k8s.io` | `dnsendpoints` | get, list, watch, create, update, patch, delete |
| `coordination.k8s.io` | `leases` | get, create, update (`resourceNames` for update) |
| `external-secrets.io` | `externalsecrets` | get, list, create, update, patch, delete (only with OpenBao) |

Plus the external-dns Role (7.4). No ClusterRole anywhere.

### 7.7 Health and status

The controller scrapes each external-dns pod's `/metrics` (pod IP, port 7979) every interval, and reports per provider:

- Deployment: ready replicas, image, last rollout.
- From metrics: time of the last successful sync, registry, source and provider error counters, and `external_dns_registry_skipped_records_owner_mismatch_per_sync` (conflicts). The exact metric names are taken from v0.23.0 and covered by a test against a recorded `/metrics` page.
- Per endpoint: `observedGeneration`.

The server stores the report on `DnsProvider.status` and `Domain.dnsPublication`; the console reads it from the server. Diagnostics lists the controller and each external-dns pod with the other containers (through its existing read access).

## 8. CRD and Chart Values

- A CRD is cluster-scoped (the `DNSEndpoint` resources are namespaced), so the installer installs `dnsendpoints.externaldns.k8s.io`, like cert-manager's CRDs, from v0.23.0's `config/crd/standard/dnsendpoints.externaldns.k8s.io.yaml`, vendored in the server repo and applied with `kubectl apply --server-side=true`. The chart does not ship it. With publishing enabled and the CRD missing, the controller reports publishing unavailable; nothing else fails.

```yaml
dns:
  publishing:
    enabled: false            # set by the installer when --dns-provider is used
  publicAddresses: []         # A/AAAA targets for the mail host
  externalDns:
    image: registry.k8s.io/external-dns/external-dns:v0.23.0@sha256:<digest>
    resources: {}
  controller:
    image:                    # pinned to an exact rapidmx/dns-controller release (7.2), moved in lock-step
      registry: ghcr.io
      repository: rapidmx/dns-controller
      tag: <x.y.z>
      digest: ""              # optional sha256:...; used instead of the tag when set
    resyncMinutes: 10
    resources: {}
  ttl: 300
mail:
  domains: []                 # 13; defaults to global.domain + postfixBridge.domains
```

## 9. Takeover of Existing Records

### 9.1 The problem

external-dns's TXT registry only changes records it owns, and it has no adopt flag or annotation (`--migrate-from-txt-owner` only moves records between two of its own owner ids). Its planner (`plan.go`, v0.23.0):

- Updates and deletes of records with another owner, or none, are silently filtered out.
- **Creates are skipped for the whole name** when any existing record of a managed type at that name is not owned. An unowned SPF TXT at the apex therefore also blocks the creation of the MX at the apex. The skip is logged at debug level only; a metric counts it.
- A TXT value that is not an ownership record is never deleted.

### 9.2 Rule

Takeover is **opt-in per provider config** (`allowTakeover`, default false; installer flag `--dns-takeover`) and only for names this deployment wants to publish. Without it, a conflicting record's state is `conflict`, and the console shows the existing value next to the wanted one with a "Take over" action for that domain (trusted role and elevation, audited `DNS_TAKEOVER`).

The apex TXT set is never taken over by `allowTakeover` alone: it needs the per-domain opt-in of 9.4.

### 9.3 Mechanism (proven on Cloudflare, 2026-10-27)

1. **Detection (server).** For each desired name, the server resolves the current records of every managed kind and the ownership TXT (`rmx-<type>.<name>`). A record present without this deployment's ownership value is a conflict.
2. **Apply (controller).** The controller runs a one-shot `Job` from the pinned image with the provider's credentials and arguments, `--registry=noop --policy=upsert-only --once`, a dedicated label filter, and a temporary `DNSEndpoint` holding the desired records **plus the ownership TXT records the TXT registry would have written**. With the noop registry, external-dns treats every record as its own and upserts it.
3. The Job and the temporary endpoint are deleted. The regular instance (`--registry=txt --policy=sync`) now sees the records as owned and manages them from then on.
4. The same Job creates a record at a name where creation is blocked by an unowned record of **another** type (9.1: the MX at an apex whose TXT set RapidMX does not manage). It only creates the wanted record and its ownership TXT; the unowned set is not touched.

**Spike results** (hand-run on powerlevel.gg against Cloudflare with external-dns v0.23.0, JP's scoped token, 2026-10-27):

- **The noop-registry takeover works.** The one-shot `--registry=noop --policy=upsert-only --once` Job overwrote the hand-made, unowned records, and afterwards a `--registry=txt --policy=sync` instance with the same owner id treated them as its own (updates and deletes applied). The fallback (a per-provider delete call) is not needed.
- **Ownership record format**, which the Job must write exactly: name `rmx-<lowercase record type>.<record name>` (for example `rmx-mx.powerlevel.gg`, `rmx-cname.openpgpkey.powerlevel.gg`); value, including the surrounding double quotes, `"heritage=external-dns,external-dns/owner=rapidmx-<installationId>,external-dns/resource=crd/<namespace>/<regular DNSEndpoint name>"`. The `resource` must name the **regular** endpoint, not the temporary one, so the regular instance does not see a resource change.
- **No TTL on ownership TXT records.** The registry writes them without `recordTTL` (the provider's default/automatic TTL); the Job's ownership endpoints carry none either, so the regular instance finds nothing to update. Only the wanted records carry `mail:dns:publish:ttl`.
- **TXT targets must be quoted** (4.2): the wanted TXT records in both the temporary and the regular endpoint are written as `"\"...\""`; unquoted targets differ from what the provider returns and are rewritten on every sync.
- **After a takeover the whole set is owned.** external-dns manages a name and type as one set: a value added at the provider by hand afterwards is **removed** on the next sync, and deleting the endpoint removes **every** value of the set, including foreign values that were deliberately carried over. This is what drives 6.5 (ownership verification off the apex), 9.4 (the apex TXT only on opt-in, edited only in the console) and 9.5 (restoring kept values).
- To verify before the controller's C4 phase: whether an unowned apex TXT set also blocks **updates and deletes** of an owned MX at the apex (the spike took over both together). If it does, the MX at an unmanaged apex is maintained through the same one-shot Job on every change.

The ownership-record format is re-checked against `registry/txt` and `registry/mapper`, and the spike re-run, whenever the external-dns pin moves.

### 9.4 The apex TXT set and SPF (DECIDED)

**Decided by JP (2026-10-27):** the root TXT set is never overwritten without the admin's per-domain opt-in, as proposed below.

Because owning a set means owning every value in it (9.3), RapidMX does **not** publish anything into a domain's apex TXT set unless an admin opts that domain in:

- **Default: not managed.** The SPF record is shown in the DNS checklist as manual (`manualReason: "apex_txt_unmanaged"`), exactly as today, with the recommended value. Ownership verification is unaffected (6.5). The MX at the apex is still published (9.3, step 4).
- **Opt-in per domain** (`PUT mail/domains/:id/apex-txt` with `{ managed: true, keep: string[] }`; trusted role and elevation; audited `DNS_TAKEOVER` with the old values): the console first shows every value currently at the apex and pre-fills an **editable "values to keep" list** with all of them except SPF records and `rapidmx-domain-verification=` values (`GET mail/domains/:id/apex-txt`, trusted role: `{ managed, keep, spf?, current, suggestedKeep }`). The admin removes what should go and adds what should be there. RapidMX then owns the set: it publishes `v=spf1 mx ~all` (or the existing SPF verbatim when it already includes `mx`; an SPF without `mx` is replaced, the old value in the audit entry) plus every value on `keep`, through the Job of 9.3 the first time (a queued `takeover` operation) and the regular instance afterwards. The chosen SPF is stored as `apexTxt.spf`.
- **As implemented (restapi step 3):** opting in needs the domain assigned to a provider config covering it (400 otherwise), and the apex looked up: a lookup that can't be answered (a timeout, SERVFAIL, anything but NXDOMAIN or NODATA) is a **503**, since an apex wrongly taken for empty would have every value deleted; `GET` then answers `lookupFailed: true` with empty `current` and `suggestedKeep`, and the console must not offer the opt-in on them. An existing SPF is kept verbatim only when it authorizes the domain's own MX hosts: a bare `mx` or `+mx`, optionally with CIDR lengths (`mx/24`, `mx//64`); `-mx`, `~mx`, `?mx` and `mx:<other domain>` don't, so such a record is replaced. `keep` takes at most 50 values of 1 to 2048 characters without control characters, trimmed and each once; an SPF record in it is a 400 (a name holds one SPF, and RapidMX publishes it), a `rapidmx-domain-verification=` value is dropped. Reassigning a managed domain to another provider or to manual is refused (409) until it opts out, since the provider owning the set must restore the kept values first. Deleting a managed domain queues the same restore as an opt-out. The restore is queued **before** the opt-out's save or the domain's deletion, and cancelled if that write then fails, so the set is never released without it. Deleting a domain assigned to a provider config, or with a managed apex set, needs an elevated token like the opt-out and the assignment (it removes the domain's public records); deleting a manual domain doesn't. `apexTxt` and `dkimRotation` are server-managed: a plain `PUT` drops them, `PUT /:id/apexTxt` is a 403, a create strips them.
- **While managed, the console is the only place to edit the apex TXT values.** It says so prominently ("Values added at your DNS host are removed within a minute; add them here"), and `keep` is editable (same elevation and audit) at any time; each edit bumps the desired-state version.
- **Opting out** (`managed: false`) or deleting the domain restores the SPF value RapidMX published there and the kept values (9.5) when the set is released. The SPF value is restored too: releasing the set deletes all of it, and a domain left without SPF fails SPF, and with a strict DMARC policy DMARC, at every receiver. The admin edits the restored values by hand from then on.
- `Domain.apexTxt` replaces the earlier `dnsPublication.preservedTxt` design, which preserved foreign values silently; this makes them visible and editable instead.

### 9.5 Uninstall and restoring kept values

Deleting a `DNSEndpoint` makes external-dns delete every value of each set it owns (9.3), so a set RapidMX took over is restored, not just deleted. For each managed apex TXT set (opt-out, domain deletion, uninstall):

1. The domain's endpoint (or the apex TXT entry in it) is removed and the controller waits until the regular instance has synced: the set and its ownership record `rmx-txt.<domain>` are gone.
2. The controller runs the one-shot noop Job (`--registry=noop --policy=upsert-only --once`) with a temporary endpoint holding **only the SPF value RapidMX published (`apexTxt.spf`) and the kept values**, quoted, and **no ownership record**, so the restored set is unowned again, as it was before RapidMX, and the domain keeps a working SPF record. The restore operation carries exactly these values.
3. The status report confirms the restored set with a live lookup; a failure is shown in the console and logged, with the values to re-add by hand.

The apex TXT set is absent for up to one sync interval plus the Job's run between steps 1 and 2; the console and the installer say so.

`single_node_install.sh --uninstall` removes only RapidMX's values:

1. Every managed apex TXT set is restored as above.
2. Every `DNSEndpoint` of the release is deleted; the installer waits (bounded) until each external-dns instance has synced, checking the live DNS for the hosts' records.
3. The release is removed.

`--keep-dns` skips all of this.

## 10. Integrations API (restapi, mounted by the server)

All routes: `@RequiresTrustedRole()` plus `assertAdminScope()` (elevation) for every write; reads are trusted role. Every write is audited (4.7) with keys, never secret values.

### 10.1 `system/dns-providers`

| Route | Behaviour |
| --- | --- |
| `GET /` | List (by name), with `status` and `domainCount` (the domains assigned). Credentials appear only as `credentials: { <key>: { "secret": true } }` per key saved (`maskSecretRef()`); the `SecretRef` itself is never returned. `GET /:id` returns one the same way. |
| `GET /types` | The provider types, their option schemas, secret fields and `tested` flag (drives the console form). |
| `POST /` | Create. Body: `name`, `type`, `zones`, `options`, `credentials` (write-only), `enabled`, `allowTakeover`. Validates the type schema; zones must be valid host names of at least two labels (a top-level domain alone is refused); the uid is generated from the name (a slug of at most 31 characters, `dns-` in front when it doesn't start with a letter, then a hyphen and 8 random characters); `origin: "console"`; credentials written to the `SecretStore` at `dns/<uid>` before the row, and removed again if the row can't be saved; 400 when credentials are sent and there is no secret store. |
| `PUT /:id` | Update; `credentials` keys omitted or given as the mask are unchanged, `null` clears (clearing every key deletes the secret and sets `secretRef: null`). `type` cannot change. Narrowing `zones` is refused (409) while an assigned domain falls outside them. A `version` other than the row's is a 409 (`INVALID_OBJECT_VERSION`, the same code as the optimistic lock's own failure) before anything is written, and the version is checked again right before the store write. The store change can't be undone (DNS credentials are never read back), so when another write lands during the store call and the row's write then fails, the row as it now is gets the new `secretRef` (unless a later credentials write already replaced it, or the row is gone, in which case the new secret is removed), the change is audited with `rowWriteFailed`, and the request still answers the 409. A `secretRef` from a backend the deployment doesn't use is never sent to the current store: clearing every key leaves it there and replacing every key writes a new secret, both audited as `secretLeftBehind`; keeping some of its keys is a 409. Names are unique through `nameKey`'s index (409 `IDENTIFIER_EXISTS`). Assigned domains are counted and checked across every page, not only the first. A request that changes nothing writes and audits nothing. |
| `POST /:id/test` | Queues a test operation: the controller runs a short `--dry-run --once` Job and reports whether it authenticated and found the zones. Trusted role and elevation; audited `DNS_PROVIDER_TEST`. Answers the queued operation. |
| `POST /:id/takeover` | Body: `domainUid`, optional `records` (record types, all the domain publishes through this config when left out); queues 9.3 with the records exactly as the desired state publishes them. The domain must be assigned to this config (400 otherwise); a record type it doesn't publish, or none publishable (rfc2136's MX), is a 400. Never includes the apex TXT set (`spf` is refused), which only `PUT mail/domains/:id/apex-txt` (9.4) manages. Trusted role and elevation; audited `DNS_TAKEOVER` with the live values. Does not need `allowTakeover`, which governs automatic takeover only. |
| `GET /:id/operations` | The config's latest 50 operations, newest first, with their state and the controller's message. Trusted role. |
| `GET /controller` | What the DNS controller last said about itself: `{ handshake, lastReport, lastStandbyReport }` (`DnsControllerState`, 4.8), `null` for what it never said. Trusted role. |
| `DELETE /:id` | 409 while any domain is assigned or a `restore` of the config is queued or running; then 7.5 deletion, cancelling its other queued or running operations. |

### 10.2 `system/integrations`

`GET` returns each section's effective values, `defaults` (from config on every request, as in 2.4), `source` per field (`"admin"` or `"deployment"`), and secrets as masks. `PUT /:section` updates one section; `POST /:section/reset` (body: optional keys, all when omitted) deletes the admin values so the deployment default applies.

As implemented (restapi step 5, `BaseIntegrationsRoute`, `src/util/IntegrationSettingsUtils.ts`):

- **Response** (`GET` and both writes): `{ <section>: { values, defaults, source }, version }`. `values` and `defaults` show a secret as the mask when set, else `null`; `stun.urls` is `null` while neither the administrator nor config sets it, or config sets an empty list (the meet plugin's built-in list); URLs from config are shown without any user name or password they carry (`withoutUrlCredentials()`: a deployment may put registry credentials in the URL, which `NpmRegistryClient` sends as Basic auth); `version` is the row's (0 before anything was saved). While the administrator's registry `url` is another registry than the deployment's (`sameRegistryUrl()`: the parsed URLs, credentials aside), the view shows what the layer does: `token` is `null` with `source: "admin"` unless the administrator set one, and the deployment's namespaces (when the administrator set none) lose the token mask of those on the default registry.
- **`PUT /:section`**: a field left out is unchanged, `null` puts it back to the deployment's value (and removes its secret), a secret sent back as the mask is kept. A namespace's `token` follows the same rule inside the list, which replaces the saved one: a namespace taken off the list loses its token. An unknown field is a 400 that lists the section's fields and never repeats what was sent. Optional `version`: a change made against another one is a 409 (`INVALID_OBJECT_VERSION`) before anything is written. A request that changes nothing writes and audits nothing.
- **`POST /:section/reset`**: body `{ keys?, version? }`; `keys` must be fields of the section.
- **Order of writes:** the request is validated first (URL lookups included), then the row is read and its version checked, then the secrets are written to the store, then the row. Every secret write goes to a new path (4.5). A write that lands meanwhile is merged field by field (the row write is retried on the newer row, at most 3 times): a secret this request set replaces whatever the row names by then (the write saved last wins) and that one is removed, and a secret another write replaced is not cleared. The plugin namespaces and their tokens are one unit: a change to the namespaces whose tokens another write changed meanwhile is a 409, never one request's list saved with the other's tokens. A secret written for a row that then can't be saved is removed (the secret in use was never touched, so nothing changes unaudited); one the row names after all (a save that failed after it was applied) is kept and logged, and while the row can't be read back they are left and logged. A cleared or replaced secret is removed after the row is saved; a removal that fails is logged and audited (`secretLeftBehind`). A reference into a backend the deployment doesn't use is never sent to the store: replacing writes a new secret here, clearing leaves it, keeping a namespace token from it is a 409.
- **Secrets without a store:** saving one is the 400 of `NullSecretStore`, also on a server that registers no `SecretStore` (the route falls back to one).
- **`defaults`** come from the route's `@Config` values (`deploymentConfig()`), with the server's built-in defaults where config sets none (`DEFAULT_RFC8823_DIRECTORY_URL`, `DEFAULT_DOH_ENDPOINT`, `DEFAULT_PLUGIN_REGISTRY`, `DEFAULT_PLUGIN_NAMESPACES`, the signing backend `manual` and the resolver `node`). They must not include the server's integrations layer (11.1): the server builds the route before installing the layer, or overrides `deploymentConfig()`.
- **Change notice:** after every saved change the route calls `integrationsChanged(settings)`, which does nothing in restapi; the server overrides it to publish `rapidmx:integrations:changed` (11.2). A failure there is logged, never the request's.
- **The layer:** `buildIntegrationsConfigLayer(settings, store, deployment)` turns the row into the flat config keys the administrator set, with the secrets read from the store (a secret the store can't give is left out and reported, so the deployment's value applies); Giphy turned off also sets `giphy:api_key` to `""`. **The deployment's registry credentials stay with the deployment's registry:** `deployment` is the server's configuration without the layer (the same flat keys `integrationDefaults()` reads), and while the administrator's registry `url` is another registry than its own, the layer sets `system:plugins:registry_token` to the administrator's token or `""` (none: also when the administrator's can't be read), and, unless the administrator set the namespaces, the deployment's namespaces without the tokens of those on the default registry (a namespace on its own registry keeps its token, which never goes to the default one). Otherwise a private registry's token would go, as `Authorization: Bearer`, to whatever host the administrator's URL names (an independent review's finding). The server's layer (server step 6) is built with it, so the route's defaults and the layer can't name different keys (`INTEGRATION_CONFIG_KEYS`).

| Section | Fields and validation | Config key(s) it overrides | Today |
| --- | --- | --- | --- |
| `giphy` | `enabled`, `apiKey` (secret) | new `giphy:enabled` (default true; read by the Giphy route from server step 6), `giphy:api_key` | config only |
| `stun` | `urls`: 1 to 10 `stun:`/`stuns:` URIs with host and optional port (an empty list is refused: the meet plugin takes one as its built-in list, 11.3, so the console would claim "no STUN servers" while meetings used the public ones; a reset is the way back to the built-in list) | new `integrations:stun:urls` | hard-coded in the meet plugin |
| `signingCa` | `backend` (`rfc8823`/`manual`/`none`), `directoryUrl` (https only), `contactEmail` | `mail:pki:signing_enrollment:backend`, `mail:pki:rfc8823:directory_url`, `mail:pki:rfc8823:contact_email` | config only |
| `dnsResolver` | `mode` (`node`/`doh-dnssec`), `dohEndpoint` (https only) | `mail:dns:resolver`, `mail:dns:doh:endpoint` | config only |
| `pluginRegistry` | `url` (https only), `token` (secret), `namespaces` (at most 20, each a scope `normalizePluginNamespaces()` accepts, listed once, with an optional https `registry` and a secret `token`) | `system:plugins:registry`, `system:plugins:registry_token`, `system:plugins:namespaces` | config only |

TURN stays in the Meet plugin's settings. Deployment infrastructure (blob/S3, mail transport and SES, ingest secret, OpenBao PKI, rspamd/ClamAV, auth-server, telemetry, Let's Encrypt, OpenSearch) stays Helm/config only.

Changing `dnsResolver` changes how every DNS check, verification and key discovery resolves; `signingCa` affects new enrollments only; `pluginRegistry` affects the next plugin install or update only. The console states these consequences next to each section.

### 10.3 Validation of URLs

Every URL field is parsed, must be `https:` (except STUN URIs), must have a host, and the host must not resolve to a private, loopback or link-local address at save time.

As implemented (`normalizeIntegrationUrl()`): at most 2048 characters without control characters; no user name or password (a credential in a URL would be saved in the database); the host is judged as the URL parser reads it (a number-encoded IPv4 address as the address it is), an IP literal directly and a name by its addresses, against the ranges key discovery refuses (`isPublicDiscoveryAddress()`: this host, private, shared and link-local networks, multicast, unique-local IPv6, and IPv4-mapped forms of them). A name that doesn't resolve, or not within 3 seconds, passes: nothing can be connected to through it either. The error names the field and never repeats the URL. STUN URIs (`normalizeStunUrls()`, 1 to 10 of them) are `stun:`/`stuns:` with a host name, IPv4 or bracketed IPv6 address and an optional port from 1 to 65535, nothing else, lowercased and each once; they are handed to browsers, never fetched by the server, so a private host is allowed. `contactEmail` is one plain address of at most 254 characters.

### 10.4 Assigning a domain

`PUT mail/domains/:id/dns-provider` with `{ dnsProviderUid: string | null }`: trusted role and elevation, checks the provider exists and its zones cover the domain (400 otherwise), audits `DOMAIN_DNS_PROVIDER_ASSIGN`, bumps the desired-state version (from restapi step 3, when `DnsPublisher` exists). Assigning the provider the domain already has changes nothing. A provider deleted, or its zones narrowed, at the same moment as an assignment can leave a domain assigned to a provider that no longer covers it; that is harmless (external-dns publishes only inside its `--domain-filter`), and the desired state (step 3) treats such an assignment as manual (`no_provider` or `outside_zones`).

## 11. Live Application

Today nothing is live (2.6). Reusing the plugin rolling restart (adding the `IntegrationSettings` version to the state hash) would restart every replica for a Giphy key change, so it is only a fallback for a consumer that cannot be made live in the first release.

### 11.1 The integrations config layer and `HostConfig`

- The server adds an nconf layer `integrations` directly below `plugins`; `integrations` is added to `CORE_CONFIG_NAMESPACES` (done in restapi step 5; every other key the layer sets was already under a protected namespace), so a plugin can never declare or save these keys. On start and on every change notice the server rebuilds the layer from the `IntegrationSettings` row, resolving secret references.
- restapi gains a static, read-only accessor `HostConfig.get(key)`, which the server installs at startup over its live nconf instance (`HostConfig.install(config)`). Before installation it returns `undefined` (`HostConfig.isInstalled()` says which). Plugins share the class with the server (restapi is their peer dependency), so nothing can write the server's configuration through it or redirect what it reads: it has no setter; an object or array value is returned as a deep copy; a configuration is installed **once** (the server does it before loading any plugin, and a later `install()` throws); `install()` returns the only handle that uninstalls it (for tests and shutdown); the installed source is module-private; and the class is frozen, so `get` can't be replaced. It is how code that was built with `@Config` (a startup snapshot) reads a value at use time, plugins included, without reaching into `ObjectFactory`'s protected `config`.

### 11.2 Propagation

A write publishes `rapidmx:integrations:changed` (row version) on Redis; every replica rebuilds the layer and notifies the consumers below. A replica that misses a message catches up within a minute (it compares the row version on a timer).

### 11.3 Consumers

| Setting | Consumer | Change |
| --- | --- | --- |
| Giphy | `server/src/routes/BaseGiphySearchRoute.ts` (`@Config("giphy:api_key")`) | Read through `HostConfig` per request. |
| STUN | meet plugin `src/util/IceServerUtils.ts` (`DEFAULT_STUN_SERVERS` hard-coded) | Reads `integrations:stun:urls` through `HostConfig` per ICE-server request; empty or `undefined` (an older server) falls back to its built-in list. Plugins may read core keys (2.5), so this needs no new plugin API, only a meet-plugin release built against the restapi version that exports `HostConfig`. |
| Signing CA | `registerCoreProviders` / `configDrivenBackend` | A delegating `SigningCertificateEnrollment` resolves the backend from config at each enrollment start; in-flight enrollments keep theirs. `Rfc8823AcmeSigningCertificateEnrollment` must read `mail:pki:rfc8823:directory_url` and `contact_email` at use time too. Done in restapi step 5: its ACME account is tied to the CA (`account.json` records the directory `account.url` was registered at, and its contact): a changed directory registers the same account key at the new CA (an account from before the record is registered again once, which `newAccount` answers with the existing account), a changed contact is sent with `updateAccount()` (a failure logged and retried next time), and each request records its CA and account, so one started before a switch is still driven at its own CA. |
| DNS resolver | `"DnsResolver"` (`NodeDnsResolver` / `DohDnssecDnsResolver`) | A delegating `DnsResolver` swaps its implementation on the change notice and drops cached answers. |
| Plugin registry | `PluginHost` (`registryFor()`) and `BasePluginRoute` (`@Config` copies) | Both build `NpmRegistryClient` per operation from current config. |
| DNS providers | DNS controller | Desired-state version bump (7.3). |

No setting requires a restart. Each consumer gets a test proving a change applies without one.

## 12. Installer (server)

### 12.1 Flags

- `--dns-provider <type>` (env `DNS_PROVIDER`): turns publishing on, installs the CRD, and creates the first provider config with `zones` = the zone of `--domain` (or `--dns-zone <zone>` when the domain is below the zone apex). For Cloudflare the installer looks up the zone id with the token.
- Credentials: `--dns-credentials-file <path>` (a `KEY=value` file, read once) or the provider's own environment variables (`CF_API_TOKEN`, `AWS_ACCESS_KEY_ID` ...), never a command-line value. The installer writes them to OpenBao (`kv/<fullname>/integrations/dns/bootstrap`) or to the provider's Kubernetes Secret, and passes only the reference to the chart (`mail:dns:bootstrap_provider`, JSON: `{ name, type, zones, options, secretRef }`), which the server turns into the `DnsProvider` row once (`origin: "installer"`) at startup, idempotently.
- `--dns-takeover`: sets `allowTakeover` on that config.
- `--public-address <ip>` (repeatable): overrides address detection (6.4).
- `--keep-dns` for `--uninstall` (9.5).

### 12.2 OpenBao

`prepareOpenbao` additionally: enables the `kubernetes` auth method (pointing at the in-cluster API, using OpenBao's own ServiceAccount for token review, which the OpenBao chart already grants); creates the roles and policies of 5.2; issues the listener certificate and switches the listener to TLS (5.2), restarting and unsealing through the existing `openbao-unsealer`; copies the CA into the release namespace; migrates the ESO and PKI tokens and revokes them. On an upgrade of an existing installation it does the same idempotently.

Renewal (**decided by JP: a reload sidecar, no restarts**): cert-manager renews the leaf certificate (1 year, renewed 30 days before expiry), and OpenBao re-reads its listener certificate on `SIGHUP`. The installer adds a small sidecar to the OpenBao pod (`shareProcessNamespace: true`), running the already-pinned OpenBao image (so no new image) with a short shell loop: every 30 s it hashes the mounted `tls.crt` and `tls.key` (the kubelet swaps the Secret volume's `..data` link when cert-manager writes the renewed Secret) and, when the hash changes, sends `SIGHUP` to the `bao server` process. It runs as OpenBao's own uid (signalling needs no capability), read-only root filesystem, all capabilities dropped. A sealed or restarted OpenBao is never involved: `SIGHUP` reloads the listener without sealing. The installer's check after an upgrade verifies the served certificate's expiry matches the Secret's.

### 12.3 Final message

With a provider: the records being published, the hosts and records that stay manual (and why), and how to watch progress. Without: the records to add per host and per domain.

### 12.4 Uninstall

As in 9.5, then the existing uninstall steps; the CRD is removed only when the installer installed it and no other release uses it.

### 12.5 The openpgpkey host

- **A provider manages the install domain**: the chart default for `mail.wkd.openpgpkeyHost.enabled` becomes on, with a **two-step HTTP-01 install**: the first `helm upgrade --install` runs without the openpgpkey host; the installer waits (bounded) until `openpgpkey.<domain>` resolves to the server; the second `helm upgrade` turns the host on, so the Certificate's HTTP-01 challenge can succeed and Helm's `--wait` does not block.
- **No provider**: the installer enables the host when `openpgpkey.<domain>` already resolves to the server, else leaves it off and prints the record to add (`--openpgpkey-host` still forces it on).
- **Admin console**: the domain's DNS panel warns when `openpgpkey.<domain>` does not resolve to this deployment.

## 13. Domain Seeding

### 13.1 Config: `mail:domains`

`mail:domains` (2.8) becomes the list of domains the deployment is installed for. Each entry is a string (the domain name) or an object:

```ts
interface SeedDomainEntry {
    name: string;
    /** The DnsProvider to assign: its `uid`, or "bootstrap" for the installer's provider config (the one `DnsProvider` with `origin: "installer"`). */
    dnsProvider?: string;
    dmarcPolicy?: "none" | "quarantine" | "reject";
    dmarcReportEmail?: string;
    /** Another seeded or existing domain this one aliases. */
    aliasOf?: string;
}
```

- A comma-separated string is accepted too (as `normalizePluginNamespaces()` accepts one), so `mail__domains=a.com,b.com` works. As implemented (restapi step 6, `parseSeedDomainEntries()`), so are the list as JSON text (a ConfigMap value nconf left unparsed) and one object on its own; names are trimmed and lowercased, and an empty name in a comma-separated string (`a.com,,b.com`) is nothing rather than a mistake.
- The chart renders the values list `mail.domains` into the service ConfigMap as JSON (`mail__domains: {{ $list | toJson | quote }}`), the same way `cors__origins` is passed. When the list is empty it defaults to `global.domain` plus each name in `postfixBridge.domains` (de-duplicated), each with `dnsProvider: "bootstrap"` when publishing is enabled. The installer's `--mail-domains` feeds it with no new flag.
- `mail:domains` is already on both protected lists. The stale doc comments (2.8) are corrected, and the `yarn dev` helper's `["example.com"]` now seeds a real `example.com` domain, which is what local development wants.

### 13.2 Validation

Each entry is validated on its own with the same rules as `BaseDomainRoute.create()`. An invalid entry is **logged as a warning and skipped**; an unknown provider, or one whose zones do not cover the name, is logged and the domain is created without a provider. Nothing here stops the server. Duplicates: the first entry wins.

As implemented (restapi step 6): the rules are literally the console's, since `BaseDomainRoute.create()` and the seeder share one create path, `prepareNewDomain()` in `util/DomainUtils.ts` (host-name check, DMARC policy, alias checks, verification token, DKIM key, reserved-TLD carve-out, 409 on an existing name). `parseSeedDomainEntries()` checks only each entry's shape first: an entry that isn't a name or an object with one, an option that isn't text, and an **unknown option key** (a misspelled `dnsprovider`) skip the entry, naming the key, rather than seeding the domain without the option, since a seeded domain is never changed again from the configuration. A skipped entry isn't recorded as seeded, so the corrected entry is seeded on a later start. `"bootstrap"` with no installer provider, or more than one, is logged and the domain created manual.

### 13.3 Behaviour

At startup, after migrations, `DomainSeeder` (restapi `src/util/DomainSeedUtils.ts`, with `DomainSeederMongo`/`DomainSeederSQL` in `src/util/{mongo,sql}/`, run by the server: `await seeder.run()`, which never throws and returns what it created, recorded, skipped and adopted):

- **Creates a domain only when it is absent and was never seeded before.** The names seeded so far are recorded in `SetupState.seededDomains: string[]`, append-only. A name on that list is never created again, so a domain the admin deleted stays deleted even when the config still lists it, and even after a `purge` delete.
- **Never overwrites an existing domain**: the admin's edits win. An existing hand-made domain is recorded as seeded without change.
- **A name removed from the list is not deleted.**
- Creates through the same code path as `create()` (verification token, DKIM key, audit entry `DOMAIN_CREATE` with `details.origin: "seed"` and no user), with `origin: "seed"`, and assigns the provider directly. As implemented, the audit entry also carries `dnsProviderUid` when one was assigned, and each created domain is announced to the `DnsPublisher`.
- **Multi-replica safety**: the create is keyed by `uid` = name, so a concurrent create by another replica fails with a collision, treated as "already there"; the `seededDomains` append uses the setup row's optimistic version with `BaseSetupRoute`'s retry. No lock is needed. As implemented, that retry is `updateSetupState()` (`util/SetupStateUtils.ts`), which `BaseSetupRoute`'s step save, `complete()` and `reopen()` now use too; each attempt appends to the row as re-read, so a name another replica recorded meanwhile is kept.
- As implemented: a name is recorded right after its domain is created or found, never before (a failed create is retried on the next start); an alias entry is created after the others, so it may alias a domain listed after it; nothing is written to the setup row unless there is a name to record; when the seeded names can't be read, nothing is seeded on that start (a deleted domain could otherwise come back), and when a name can't be recorded, the next start records the existing domain. `seededDomains` is read again right before each create (after the entry's key is generated), so a domain another replica seeded and the admin deleted while this replica was still busy with earlier entries isn't created again.
- **Upgrades are adopted, not seeded** (decided in restapi step 6 review): "never re-created after deletion" can only hold for deletions the seeder saw. On a deployment that predates seeding, a listed name may be a domain the admin deleted back then, or one never added on purpose (the chart default lists `global.domain`, often only the hosts' base domain), and creating it would mint a DKIM key and, with the bootstrap provider, publish its records. So while `seededDomains` is empty and a domain from before `Domain.origin` exists (counted as all domains minus `origin: "seed"` minus `origin: "console"`; total read first, so a concurrent seed create can only hide, never fake, an old row), the seeder records every listed name as seeded without creating any (`adopted` in the result, with a warning telling the admin to add any missing one in the console). Names added to the list afterwards are seeded normally. A fresh install never has such rows (every domain it gets has an origin), and a deployment from before seeding with no domains left is seeded like a fresh one. When the domains can't be counted, nothing is seeded that start; when the adoption can't be recorded, the next start adopts again. Not keyed on a completed setup: on a fresh install an admin can finish setup before a corrected entry is seeded, and that entry must still be created.

### 13.4 Verification

With a provider, the ownership TXT is published with the other records, so `DomainVerificationJob` verifies the domain within minutes. Without one, it stays unverified until the admin publishes the TXT record. A reserved-TLD domain starts verified, as today.

### 13.5 Setup wizard

- `BaseSetupRoute.toStatus()`: "no domains" becomes "no domains other than seeded ones" (`origin !== "seed"`), so a fresh install with seeded domains still gets the wizard, and an existing deployment is never pulled into it. As implemented, it compares the count of all domains with the count of `origin: "seed"` ones (required when the seeded count is at least the total, so a domain seeded between the two reads doesn't flip it), since an `origin != 'seed'` filter on SQL would leave out the rows without an origin.
- The wizard's `domain` step lists the seeded domains as already added ("Added from your installation"), each with its DNS panel. Adding more stays available, and the step no longer blocks when a seeded domain exists.
- The installer's final message says the domains are already in the admin console.

## 14. Console UX (web-client)

- **Integrations** (new admin section, `apps/admin/integrations`), one page per area, following the policy pages' pattern (per-field "Reset to deployment default", the deployment value shown beneath, elevation prompt on save):
  - **DNS providers**: list with type, zones, status (Running / Not ready / Error with the last error / Disabled), assigned domain count. Create/edit form generated from `GET /types`, with a "not yet live-tested" badge where applicable; write-only credential fields ("Set" with a Replace button); "Test connection"; "Allow taking over existing records" with an explanation.
  - **Giphy**, **STUN servers**, **S/MIME signing CA**, **DNS resolver**, **Plugin registry**.
- **Domains**: a "DNS provider" select (Manual, or each provider whose zones cover the domain). The DNS list gains a "Published" column: Automatic (published / pending / conflict with "Take over") or Manual with its reason, beside the live check. An unreachable `openpgpkey.` host shows a warning.
- **DKIM** on each domain: the active selector and its age, the rotation phase with the next step ("waiting for the new record to be live", "switching", "old key retires on <date>"), "Rotate now", "Key compromised: rotate now", "Cancel rotation", "Pause scheduled rotation", and, for manual domains, the record to publish.
- **Setup wizard**: as in 13.5.
- **Diagnostics**: the DNS controller and external-dns pods; the integrations config layer as a source; secrets shown only as "set".

## 15. Security Considerations

- **Kubernetes rights are isolated.** The internet-facing server keeps read-only Kubernetes access. The controller holds the write rights, but runs its own minimal image (no server code, no runtime dependencies, distroless, non-root, read-only root filesystem), has no database or Redis access, accepts only the server's authenticated calls, runs only the pinned external-dns image, and has a NetworkPolicy admitting only the server.
- **Credential exposure.** DNS credentials can redirect a domain's mail and obtain certificates for it. They live only in the secret store, are never readable back by the server (OpenBao policy without `read`), are absent from logs, audit entries, Diagnostics and Deployment specs, and reach only their own external-dns pod. With the Kubernetes-Secret backend they cross the cluster network once, from server to controller, as the existing internal mail traffic does. Recommend scoped tokens; for Cloudflare: Zone:Zone:Read and Zone:DNS:Edit on the one zone, with its zone id in the config.
- **OpenBao** is reached over TLS with a pinned CA, and every client logs in with a short-lived, audience-bound ServiceAccount token to a policy scoped to its own paths. No long-lived tokens remain.
- **Who can publish.** Creating providers, changing credentials, assigning a domain, taking over records, rotating DKIM and changing integrations all need a trusted role and an elevated token, and are audited. Adding a domain (trusted role, as today) can now create public DNS records automatically, but only inside zones an elevated admin attached to a provider config.
- **Zone confinement.** A provider config can only touch its zones: `--domain-filter`, the zone check on assignment and seeding, and the credentials' own scope. The TXT registry and the per-deployment owner id keep each deployment to its own records in a shared zone.
- **Ownership verification.** When RapidMX publishes its own verification TXT, verification proves that this deployment holds credentials able to edit the zone, which is at least as strong as pasting the record by hand. It no longer proves that a separate human acted; that is acceptable because attaching the provider already required an elevated admin. Verification is still only by public DNS lookup. The record lives at `_rapidmx-verify.<domain>` (6.5), so verifying never puts the apex TXT set under RapidMX's control.
- **Takeover** can overwrite records other systems depend on, and a taken-over set is owned whole (9.3): opt-in per provider, per-domain confirmation, the apex TXT set only on its own opt-in with an explicit, editable list of values to keep (9.4), kept values restored on opt-out, deletion and uninstall (9.5), and the old values in the audit entry.
- **Version skew.** The controller and the server refuse to act on an API version they do not both speak (7.3), so a mismatched pair cannot misread desired state into wrong records.
- **DKIM rotation** never switches signing to a key whose record is not live, so a rotation cannot break DKIM; a compromised key is retired as soon as signing has switched.
- **SSRF.** URL fields are validated as in 10.3.

## 16. Failure Modes

| Failure | Behaviour |
| --- | --- |
| CRD not installed | Publishing reported unavailable; domains behave as manual. |
| Controller down | Desired state keeps accumulating; nothing is published or removed until it is back; the console shows the controller as down. |
| Controller and server API versions incompatible | The controller refuses to act (no Lease, no writes), reports not ready, retries the handshake every 60 s; the server records the mismatch and the console shows both versions. |
| Lease lost (API server unreachable, pod paused) | The controller stops writing at once and re-acquires before writing again. |
| Restoring kept apex values fails | Shown in the console with the values to re-add by hand; logged. |
| Controller cannot verify the server's token (JWKS unreachable) | It refuses the call; the console shows the error; the Kubernetes-Secret backend cannot save credentials meanwhile. |
| Bad credentials / provider API down | external-dns retries; the provider shows Error with the last error; records keep their last state. |
| Record conflict | `conflict` with the existing value; nothing overwritten unless takeover. |
| Provider cannot hold a kind | That record is manual with its reason; the others publish. |
| A provider config's row write fails after its credentials changed in the store | The row is pointed at the new `secretRef` (so the masks and the pod-template generation follow the store), the change is audited with `rowWriteFailed`, and the request answers 409 for the rest; if even that write fails, the mismatch is logged and audited with `rowMatchesStore: false`. |
| OpenBao sealed or unreachable | Credential writes fail with 503; running external-dns pods keep their Secret; server-side secrets keep their cached value and warn. |
| New DKIM record never goes live | Rotation stays `pending`, signing unchanged; the console reminds the admin. |
| postfix-bridge does not acknowledge a switch | Both selectors stay published; no overlap clock; `lastError` shown; the admin may cancel, which reverts signing to the old key. |
| Two deployments share a zone | Separate owner ids; a name both want is a conflict for the second. |
| An external-dns Deployment removed by hand | The next reconcile re-creates it. |
| Public addresses empty or private | Hosts not published; the console says why. |

## 17. Testing

- **restapi unit + real DB (Mongo and SQL)**: `DnsProvider` CRUD and validation per type; masks and write-only behaviour; elevation and audit on every write; `buildDesiredDnsRecords()` equals `checkDnsSetup()`'s recommendations for every combination (DKIM missing, rotation phases, autodiscover on/off, alias, rfc2136 kinds); the `_rapidmx-verify` verification name and the legacy apex transition (6.5); apex TXT opt-in, keep-list editing and restore operations (9.4, 9.5); the handshake route (version selection, mismatch recorded, `apiVersion` rejected per call) against shared contract fixtures; `IntegrationSettings` seed/defaults/reset; assignment rules; the desired-state route (version, long poll, no secret values) and status route (subject check); `DkimRotationJob` through every phase, including the manual-domain wait, cancel, compromised, a missing acknowledgement and two replicas racing; `DomainSeeder` (create once, never after delete or purge, never overwrite, skip invalid entries, comma-separated input, concurrent seeding); `toStatus()` with seeded domains; plugin secret migration.
- **dns-controller unit** (its own repository, 100 % coverage thresholds like the siblings): configuration, logging, health endpoints, the Kubernetes client against a fake transport (token re-read, CA, error mapping), Lease acquisition, renewal, loss and the skew-safe expiry rule, the handshake and refusal on mismatch, the shared contract fixtures; later phases: manifests golden-tested per provider (no credential in any manifest or log, image pin enforced, quoted TXT, ownership records without TTL), token verification against a fake JWKS, Job specs for takeover and restore, metric parsing against a recorded v0.23.0 `/metrics` page. `docker build` in CI.
- **server unit**: token verification of the controller's calls against a fake JWKS; the Kubernetes-Secret and OpenBao backends against a fake API server and fake OpenBao (Kubernetes login, a write without read on DNS paths); each live consumer changes without restart. (`FsDkimKeyProvider`'s per-selector files, `activate()` and `signingSelector()` are restapi unit tests, since the class lives there.)
- **postfix-bridge**: `dkim-sync.sh` tests (per-domain selector, fallback to the global one, acknowledgement written only after a reload).
- **chart**: `helm template` tests that the server's Role has no write verbs, the controller Role is namespaced, `mail__domains` and `mail__dns__publish__*` render, and the openpgpkey two-step defaults.
- **CI**: a kind cluster job with the CRD, the chart, the controller and external-dns pointed at an in-cluster bind9 (`rfc2136` with TSIG and AXFR): create, update, DKIM rotation end to end (with a test hook shortening the grace and overlap), delete, reassignment, conflict, takeover, apex TXT opt-in with kept values and their restore, uninstall cleanup, and a deliberately mismatched controller version refusing to act. rfc2136 cannot manage MX or SRV, so CI covers A/AAAA/CNAME/TXT and the manual state; MX and SRV are covered by the Cloudflare e2e.
- **Other providers** (route53, google, azure): unit tests only, against recorded API fixtures; marked "not yet live-tested".
- **e2e on powerlevel.gg** with Cloudflare, local helm package first, release only after it passes:
  1. ~~First, prove takeover~~ (9.3): **done 2026-10-27**, the noop-registry takeover works on Cloudflare. Still to check: the open point at the end of 9.3 (an unowned apex TXT blocking MX updates).
  2. Install with `--dns-provider cloudflare --dns-takeover`, credentials from a file on the host only.
  3. Verify takeover (MX, `_dmarc`, hosts), the apex TXT opt-in with its keep list, automatic verification of the seeded domain through `_rapidmx-verify`, and the openpgpkey host on and certified.
  4. Rotate DKIM ("Rotate now" with a shortened grace and overlap), check that mail sent before, during and after the switch verifies at an external receiver.
  5. Add and delete a second domain; change DMARC; reassign to manual.
  6. Check the controller and external-dns logs and metrics after deploy.
  7. Uninstall with and without `--keep-dns`, checking that only RapidMX's values were removed and kept apex values were restored.
  The token is never committed or stored anywhere but the test host's OpenBao/Secret, and JP rotates it afterwards.

## 18. Implementation Plan

Process per the 2026-10-27 rules: reproduce or test first, an independent review of each diff before commit, CI green before release. Order: spec, restapi, dns-controller, server, postfix-bridge, web-client, meet-plugin, powerlevel.gg e2e, release (restapi minor, dns-controller first release, web-client minor, server beta pinning that controller release; postfix-bridge and meet-plugin at the level their changes need).

**restapi**
1. `SecretStore` interface + `NullSecretStore`; `SecretRef`; masks shared with plugin settings; `HostConfig`.
2. `DnsProvider` model, types registry, `BaseDnsProviderRoute`; `Domain` fields and `PUT /:id/dns-provider`; `DeploymentIdentity`; audit actions. (The queued `test`/`takeover` routes move to step 3, which brings the operations queue.)
3. `POST system/dns-providers/:id/test` and `/:id/takeover` (with `GET /:id/operations` and `GET /controller`); `buildDesiredDnsRecords()` and the `checkDnsSetup()` refactor (with `dkim_next`/`dkim_previous`, manual reasons, publication states); `_rapidmx-verify` verification with the legacy apex transition (6.5); `DnsPublisher` + `NullDnsPublisher`; `DnsControllerTokenVerifier`; `DnsOperation` and `DnsControllerState` (4.8); `BaseDnsDesiredStateRoute` (handshake, `/v1` desired state, status, operations) with the `v1` API types and the contract fixtures shared with dns-controller; `Domain.apexTxt` (and the `dkimRotation` field it reads), `GET`/`PUT /:id/apex-txt`.
4. DKIM rotation: `DkimKeyProvider` additions, `Domain.dkimRotation`/`dkimManaged`, `DkimRotationJob`, rotate/cancel/pause routes.
5. `IntegrationSettings` model and `BaseIntegrationsRoute`; `integrations` in `CORE_CONFIG_NAMESPACES`; `buildIntegrationsConfigLayer()` for the server's layer; the RFC 8823 ACME account tied to its CA (11.3).
6. `DomainSeeder` over `mail:domains`, `SetupState.seededDomains`, `Domain.origin`, `toStatus()` change; stale `mail:domains` comments corrected.
7. Plugin-setting secret references and the migration helper.

**dns-controller** (new repository, 7.2): phases C1 (skeleton: config, logging, health, Kubernetes client, Lease, `v1` types and handshake; scaffolded locally 2026-10-27) to C5, each released only when the server needs it; the first release precedes the server release that pins it.

**server**
1. ~~Takeover proof on powerlevel.gg~~: done 2026-10-27, noop takeover chosen (9.3).
2. OpenBao: Kubernetes-auth clients for the secret store and the PKI CA, CA-bundle support; installer `prepareOpenbao` changes (auth method, roles, TLS listener, the `SIGHUP` reload sidecar, CA copy, token migration and revocation).
3. (moved to the dns-controller repository.)
4. Server side: `DnsPublisher` (version counter), token verification for `/internal/dns`, `SecretStore` backends, hidden settings.
5. Register `DkimRotationJob` (Mongo and SQL) and document `mail:jobs:dkim_rotation:schedule` and `mail:dkim:rotation:*`; the `FsDkimKeyProvider` rotation methods moved to restapi step 4, where the class lives.
6. Integrations config layer (built with restapi's `buildIntegrationsConfigLayer()`, passed the configuration without the layer as `deployment`; the route's `integrationsChanged()` overridden to publish the change; its defaults read without the layer), `HostConfig.install()`, propagation, and the live consumers (including `giphy:enabled` and the signing backend `none`).
7. Run the seeder at startup; bootstrap provider from `mail:dns:bootstrap_provider`; `yarn dev` seeding.
8. Chart: values (including the pinned `dns.controller.image`), controller Deployment/Service/NetworkPolicy/ServiceAccount/Role/RoleBinding and its projected-token volume, external-dns ServiceAccount/Role, `mail__domains`, hosts/addresses config, OpenBao CA mount, openpgpkey defaults.
9. Installer: `--dns-provider`, credentials, `--dns-zone`, `--dns-takeover`, `--public-address` and detection, CRD install, two-step openpgpkey, uninstall (9.5) and `--keep-dns`, final message.
10. Remove the beta.46 opt-in note from README/release notes as appropriate.

**postfix-bridge**: per-domain selectors and the `<domain>.signing` acknowledgement in `dkim-sync.sh` and the init container; the server chart's `postfixBridge` dependency moves to that release.

**web-client**
1. Integrations section and pages; DNS provider form from `GET /types`.
2. Domains: provider select, publication column, takeover action, openpgpkey warning, DKIM rotation panel.
3. Setup wizard: seeded domains on the domain step.
4. Diagnostics additions.

**meet-plugin**: STUN from `HostConfig.get("integrations:stun:urls")` with the built-in fallback.

Then the powerlevel.gg e2e (17), then the releases.

## Open Questions

1. **Route 53 TXT quoting**: expected to match Cloudflare's (quoted), settled only when Route 53 is live-tested; until then the type carries the "not yet live-tested" badge.
2. **Unowned apex TXT and the apex MX** (end of 9.3): whether it also blocks updates and deletes of the owned MX; checked on powerlevel.gg before controller phase C4.

Settled since the first draft: the OpenBao certificate reload (sidecar, 12.2), JWKS access on k3s (in-cluster fetch, confirmed, 7.3) and the apex TXT set (opt-in only, 9.4).

## Resolved Decisions

From JP, 2026-10-27:

- external-dns, not OctoDNS: a Kubernetes controller with about 40 providers, touching only records it owns, reading `DNSEndpoint`s from one namespace; its CRD is an installer-level install like cert-manager's. Pinned at v0.23.0.
- Records: exactly what `checkDnsSetup()` recommends, plus the deployment's hosts (A/AAAA for the mail host to the public addresses; CNAMEs for auth, autodiscover, openpgpkey).
- Domain add/remove and DKIM changes publish automatically.
- Per-domain provider ("manual" allowed), configured in the console; one external-dns Deployment per provider config, with a pinned image, a credentials Secret and a label filter.
- **Kubernetes writes go through a separate DNS controller pod** with its own ServiceAccount and namespace Role; the server keeps only its read-only access and records desired state (§7). The controller is a **dedicated project and image**, `rapidmx/dns-controller` (`ghcr.io/rapidmx/dns-controller`), not the server image with another command, so the one pod that can create Deployments, Secrets and Jobs carries no server code; the server chart templates it and pins its image in lock-step. It reads desired state through a **versioned** internal API (`/internal/dns/v1`, `apiVersion` in every payload, startup handshake, refusal on mismatch) authenticated with projected ServiceAccount tokens verified against the in-cluster JWKS, runs as one replica with a lease, and reports status back through the same API.
- **OpenBao**: Kubernetes auth for every client, narrowly scoped policies, TLS on the in-cluster listener with an installer-issued certificate, no new long-lived tokens (and the existing ones migrated).
- **openpgpkey certificate**: two-step HTTP-01 install.
- **DKIM rotation is built now** (6.2): scheduled and on demand, new selector published and observed live before signing switches, old selector kept for the overlap, then retired; manual domains wait for the admin.
- Takeover: the noop-registry Job, **proven on powerlevel.gg with Cloudflare on 2026-10-27** (9.3); the per-provider delete fallback is dropped.
- **Ownership verification at `_rapidmx-verify.<domain>`** (6.5), never in the apex TXT set; existing domains migrate with both locations accepted during a transition, only the new name recommended and published.
- **The apex TXT set is never overwritten without opt-in** (9.4): SPF stays manual until the admin opts a domain in, with an editable list of the values to keep, restored on opt-out, deletion and uninstall.
- **OpenBao listener certificate**: reloaded by a `SIGHUP` sidecar on change, no restarts (12.2).
- **JWKS** fetched in-cluster at `https://kubernetes.default.svc/openid/v1/jwks`; the issuer-discovery binding was confirmed on k3s v1.36.4.
- rfc2136 stays, with MX/SRV shown as manual. Cloudflare is the e2e-tested provider; the others are unit-tested and marked not yet live-tested. DigitalOcean and webhook providers come later.
- The installer detects public addresses, with `--public-address` to override.
- Hosts outside every provider's zones stay manual and are marked so.
- Uninstall removes only RapidMX's values and restores kept values of sets it took over (9.5).
- Health comes from external-dns's metrics endpoint.
- Integrations: DNS providers, Giphy, STUN, signing CA, DNS resolver, plugin registry; TURN stays in Meet; infrastructure stays Helm/config. Typed, trusted role and elevation, audited, live-applied, reset to deployment default.
- STUN reaches the meet plugin as `integrations:stun:urls` through restapi's `HostConfig` (plugins may already read core keys; `@Config` is only a startup snapshot).
- Secrets outside the DB (OpenBao, else Kubernetes Secrets), write-only, hidden from Diagnostics; plugin-setting secrets move there too.
- The chart seeds the install's domains through `mail:domains` (unused at runtime until now): any number of entries, each with its own options; bad entries logged and skipped; never re-created after deletion; never deleted when removed from the list. A deployment that predates seeding has its first list adopted (recorded, not created; 13.3).
- Takeover of the existing powerlevel.gg records is approved for the e2e test.

## Status

Design, revised 2026-10-27 (dedicated dns-controller project, versioned API, spike results, `_rapidmx-verify`, apex TXT opt-in decided). The dns-controller C1 skeleton exists in its own repository. restapi step 1 (`SecretStore`, `NullSecretStore`, `SecretRef`, the shared masks, `HostConfig`), step 2 (`DnsProvider` with `BaseDnsProviderRoute` and the types registry, `Domain.dnsProviderUid`/`dnsPublication` with `PUT /:id/dns-provider`, `DeploymentIdentity`, the audit actions) and step 3 (the desired records and checklist publication states, `_rapidmx-verify` with the legacy apex transition, `DnsPublisher`, `DnsControllerTokenVerifier`, `DnsOperation`, `DnsControllerState`, `BaseDnsDesiredStateRoute`, the queued test and takeover operations, the apex TXT opt-in) and step 4 (DKIM rotation: the `DkimKeyProvider` additions with `findKeyPair()`, `FsDkimKeyProvider`'s per-domain selectors, `Domain.dkimManaged`, `DkimRotationJob`, the rotate, cancel, pause and view routes, `DKIM_ROTATION_PAUSED`) and step 5 (`IntegrationSettings`, `BaseIntegrationsRoute` at `system/integrations` with a secret path per write, `buildIntegrationsConfigLayer()` keeping the deployment's registry credentials with the deployment's registry, `integrations` in `CORE_CONFIG_NAMESPACES`, the RFC 8823 ACME account tied to its CA) and step 6 (`DomainSeeder` over `mail:domains` with the create path it shares with the console, `SetupState.seededDomains`, `Domain.origin`, `toStatus()` setting seeded domains apart, the stale `mail:domains` comments corrected) are implemented; no server code yet. With step 3, dns-controller's copy of the `v1` types and its contract fixtures gained list-valued provider options (the fixtures stay byte-identical in both repositories). **Prerequisite of the server's bump to this restapi release, in the same change:** list `DnsProvider`, `DeploymentIdentity`, `DnsOperation` and `DnsControllerState` in its Mongo and SQL model lists, register a `SecretStore` (`NullSecretStore` until its backends exist: the route injects one) and mount `system/dns-providers`. Without the model lists the domain route still boots (it logs a warning and answers an assignment to a provider, or an apex TXT opt-in, with 503), but the DNS provider route can't be mounted. Registering a `DnsPublisher` is optional (the routes fall back to `NullDnsPublisher`); `/internal/dns` is mounted with server step 4, together with its `DnsPublisher` and `DnsControllerTokenVerifier` (without a verifier every call is refused) and `mail:dns:controller:subject`. DKIM rotation runs only once the server registers `DkimRotationJobMongo`/`DkimRotationJobSQL` with its other jobs (server step 5); until then "Rotate now" only creates and publishes the new key, and nothing switches. `mail:jobs:dkim_rotation` is now in `CORE_CONFIG_NAMESPACES`, and the server's `PROTECTED_PLUGIN_SETTING_KEYS` must list it too. With step 5 the server, in the same change as its bump, lists `IntegrationSettingsMongo`/`IntegrationSettingsSQL` in its model lists and mounts `system/integrations` (nothing reads the row before server step 6), and its `PROTECTED_PLUGIN_SETTING_KEYS` lists `integrations`; `hiddenSettings.ts` already hides `giphy:api_key`, `system:plugins:registry_token` and `system:plugins:namespaces`. Step 6 needs no new model in the server's lists (it uses `Domain`, `SetupState`, `DnsProvider` and `AuditLogEntry`); in server step 7 the server runs `DomainSeederMongo`/`DomainSeederSQL` once at startup, after its datastores are connected and after it has created the bootstrap provider config with `origin: "installer"` (`await (await objectFactory.newInstance(DomainSeederMongo, { name: "default" })).run()`, logging the result), and the `yarn dev` helper's `["example.com"]` then seeds a real domain. Any server code that creates `Domain` rows itself must set `origin` (`"console"` or `"seed"`): a row without one reads as a domain from before seeding, which makes the seeder adopt rather than seed while nothing is recorded yet. An upgraded deployment's first non-empty `mail:domains` is adopted, so the chart default never creates `global.domain` or a deleted domain there. New config keys to document in the server: `mail:jobs:dkim_rotation:schedule`, `mail:dkim:rotation:enabled`, `mail:dkim:rotation:interval_days`, `mail:dkim:rotation:overlap_days`, `mail:dkim:rotation:publish_grace_hours`, `mail:dkim:rotation:key_bits`, `mail:dkim:rotation:max_starts_per_run`, `mail:domain_verification:accept_legacy_apex`, `mail:dns:controller:subject`, `mail:dns:desired_state:long_poll_seconds`, `mail:dns:publish:ttl`, `mail:dns:publish:hosts`, `mail:dns:publish:addresses`, `mail:dns:publish:external_dns_image`.
