# RapidMX: DNS Publishing and Admin-Console Integrations

This document is the technical design for two linked features across `@rapidmx/restapi`, `@rapidmx/server` and `@rapidmx/web-client`:

1. **DNS publishing.** The server publishes every DNS record a deployment and its domains need, through [external-dns](https://github.com/kubernetes-sigs/external-dns), using per-domain DNS provider configurations an administrator manages in the admin console.
2. **Integrations.** Third-party services an administrator chooses (DNS providers, Giphy, STUN, the S/MIME signing CA, the DNS resolver, the plugin registry) move from deployment-only configuration to typed, audited, live-applied settings in the admin console, with their secrets held outside the database.
3. **Domain seeding.** The domains a deployment is installed for exist in the server from its first start, instead of being added again by hand in the admin console.

The decisions this document implements were made with JP on 2026-10-27 and are not re-litigated here (see *Resolved Decisions*). It supersedes the beta.46 stopgap that made the `openpgpkey.<domain>` host opt-in.

## 1. Why

The Helm chart cannot know whether a host's DNS record exists. A feature that needs a host either breaks an install or upgrade (Helm 4's `--wait` waits on cert-manager `Certificate`s, which cannot be issued for a name without a record) or ships disabled. Today that applies to `openpgpkey.<domain>` and, equally, to `mail.`, `auth.` and `autodiscover.` and to each domain's MX, SPF, DKIM and DMARC records, all of which an operator copies by hand from the admin console's DNS checklist (`GET /mail/domains/:id/dns-setup`).

Publishing those records ourselves removes the manual step, so hosts can default on, and a domain added in the admin console starts receiving mail without a trip to the registrar.

## 2. Current Architecture

Grounding for the design below. Paths are relative to each repo.

### 2.1 What the server recommends (restapi)

`src/util/DnsSetupUtils.ts` `checkDnsSetup(dnsResolver, domain, mxHostname, autodiscoverHostname?)` computes and live-checks, per `Domain`:

| `DnsRecordType` | Kind | Name | Recommended value | Configured when |
| --- | --- | --- | --- | --- |
| `ownership` | TXT | `<domain>` | `rapidmx-domain-verification=<verificationToken>` | always |
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
- `POST /:id/verify` and `DomainVerificationJob` (`mail:jobs:domain_verification:schedule`, every 5 minutes) flip `verified` when the TXT record is found.
- `GET /:id/dns-setup` backfills a missing DKIM key pair, then returns `checkDnsSetup()`.
- Every create, update, delete and verification writes an `AuditLogEntry` (`DOMAIN_CREATE`/`UPDATE`/`DELETE`/`VERIFIED`).
- A pure alias domain (`aliasOf`) has its own ownership proof and DKIM key, and its own DNS records.

### 2.3 DKIM keys

The server registers `FsDkimKeyProvider` (`server/src/lib/registerCoreProviders.ts`): one RSA key per domain at `<mail:dkim:key_dir>/<domain>.<mail:dkim:selector>.key`, read by rspamd. `DkimKeyProvider.ensureKeyPair()` is documented as never rotating: **DKIM rotation does not exist today.** The only way the published key changes is an admin editing `dkimSelector`/`dkimPublicKey` on the domain (importing an externally managed key). This design therefore reconciles on any change to those two fields, and is ready for a rotation operation when one is built (see *Open Questions*).

### 2.4 Policy singletons (restapi)

`BaseMailboxPolicyRoute` (`system/mailbox-policy`) and `BaseEncryptionPolicyRoute` (`system/encryption-policy`) are the pattern Integrations follows:

- A singleton row, seeded from `@Config` values the first time it is read (`findOrSeedMailboxPolicy()`).
- The response carries `defaults`, read from config on every request, which is what the console's per-field "reset" puts a field back to. A row field that is missing (`null` on SQL) takes the config value.
- `PUT` is `@RequiresTrustedRole()` and writes an audit entry with the patch.
- Elevation (`assertAdminScope(user, trustedRoles, mail:security:elevation_max_age_seconds)`) is required for administrative actions with a larger blast radius (plugins, escrow, data export, erasure).

### 2.5 Plugin settings (restapi + server)

- A plugin's settings are saved on its `Plugin` row (`Plugin.settings`), **in plaintext**, and loaded by the server's plugin host into the first nconf layer (`PLUGIN_SETTINGS_STORE = "plugins"`), so a saved setting wins over the command line, environment and defaults.
- `CORE_CONFIG_NAMESPACES` (`src/plugins/PluginUtils.ts`, mirrored by the server's `PROTECTED_PLUGIN_SETTING_KEYS` in `src/config.defaults.ts`) lists the namespaces a plugin setting may never write. `giphy`, `mail:dns`, `mail:pki` and `system:plugins` are on it, which is why a plugin cannot be how an admin sets them.
- A secret setting (`isSecretSetting()`: key words, `secret: true` or `type: "password"` in the manifest) is masked in responses as `{ "secret": true }` (`maskSecretSettings()`), and sending the mask back means "left alone" (`isMaskedSecret()`).
- The server's Diagnostics page hides config values named on an explicit list (`server/src/diagnostics/hiddenSettings.ts`), never by name-guessing.

### 2.6 Kubernetes and OpenBao (server)

- The server already talks to the Kubernetes API, from `src/diagnostics/KubeClient.ts`: a small hand-written HTTPS client using the pod's service account token (re-read on every request, since bound tokens rotate), its namespace file and the cluster CA. It is GET-only and deliberately avoids `@kubernetes/client-node` to keep that dependency tree out of the mail server.
- The chart grants it a **namespace Role** (`helm/templates/0_config/diagnostics-rbac.yaml`: `get`/`list` on `pods`, `persistentvolumeclaims` and `metrics.k8s.io` `pods`), bound to the chart's ServiceAccount, behind `global.diagnostics.rbac.create`. There is no ClusterRole, per the standing rule.
- The ServiceAccount (`0_config/service-account.yaml`) is created by default (`global.serviceAccount.create: true` in `values.yaml`; the template comment saying "off by default" is stale). The server pod mounts its token (no `automountServiceAccountToken: false`); clamav, coturn and rspamd do not.
- OpenBao, when the installer installs or uses it (`--openbao`, default true), holds the release's secrets at `<OPENBAO_KV_MOUNT>/<FULLNAME>/secrets`; External Secrets (`helm/templates/4_vault/external-secrets.yaml`, `SecretStore <fullname>-openbao`) syncs them into the Kubernetes Secrets the pods read. `prepareOpenbao()` enables KV v2, a PKI mount, two read-only policies and two **orphan periodic tokens** (`<fullname>-openbao-eso`, `<fullname>-openbao-pki`); **no Kubernetes auth method is enabled**. The chart's `SecretStore` supports `global.openbao.auth.method: kubernetes` but the installer uses `token`.
- The server process does not talk to OpenBao at runtime today. restapi's `OpenBaoPkiCertificateAuthority` (static token, `mail:pki:openbao:token`) exists, but the chart never sets `mail__pki__backend`, and its `assertSafeAddress()` would refuse the in-cluster `http://openbao.openbao.svc:8200` anyway.
- **Every config value is a startup snapshot.** `@Config` fields are assigned once by `ObjectFactory` at instantiation, and `registerCoreProviders()` picks the `DnsResolver`, CA and signing-enrollment implementations once per process. Saving a plugin setting changes `computePluginStateHash()`, which makes `PluginWatcher` roll every replica's worker under a Redis restart lock (`PluginRestartLock`, `plugins:restart-lock`). That is how "live" plugin settings work today.
- There is no general leader election. The reusable single-writer pieces are the Redis lock with a fencing token in `src/plugins/PluginWatcher.ts` (`SET NX PX`, Lua renew-if-held and delete-if-held) and the DB lease in `src/plugins/PluginPurgeLedger.ts`.
- The server never learns its public addresses (only names, through config), and the installer detects none: its final message tells the operator to point A/AAAA "to this machine". The only address detection anywhere is coturn's `detect-external-ip`. The only existing DNS automation is `deploy/aws/bootstrap.sh`'s optional Route 53 `upsertCname()`.
- List-valued config reaches the server as a JSON string in the service ConfigMap (e.g. `cors__origins: {{ $origins | toJson | quote }}`), parsed by nconf's `.env({ separator: "__", parseValues: true })`.

### 2.7 The installer (server)

`single_node_install.sh` takes `--domain`, `--mail-host`, `--auth-host`, `--mail-domains` (default `<domain>`, passed to `postfixBridge.domains`), `--openbao`, `--openpgpkey-host`, `--tls`, `--gateway`, `--install-cert-manager`, `--uninstall` and others. Its final message tells the operator to "Add each domain in the admin console, publish the DNS records it shows". The first-run setup wizard (web-client `apps/shared/components/admin/setup/SetupWizard.tsx`, steps `plugins`, `domain`, `settings`, `escrow`, `mailboxes`, `branding`) makes the administrator add that same domain again. `BaseSetupRoute` reports setup `required` on a deployment that has started the wizard or has no domains.

## 3. Concepts

- **DNS provider config** (`DnsProvider`): a named, admin-managed configuration of one DNS hosting account: its type (`cloudflare`, `route53`, ...), non-secret options, the zones it may touch, and a reference to its credentials in the secret store.
- **Assignment**: each `Domain` has `dnsProviderUid`, naming a provider config, or nothing ("manual": the admin publishes records by hand, exactly as today).
- **Publication**: the server's desired DNS records for a domain or for the deployment's own hosts, written as `DNSEndpoint` custom resources. One external-dns instance per provider config reads only the ones labelled for it and applies them.
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
    type: DnsProviderType;
    /** The zones (apex names) this config may publish into: external-dns's --domain-filter. At least one. A Domain may be
     * assigned to this config only when its name is one of these or under one of them. */
    zones: string[];
    /** Non-secret, type-specific options, validated per type (4.2). */
    options: Record<string, string | number | boolean>;
    /** Where the credentials are: a reference, never the value (5). Unset until credentials are saved. */
    secretRef?: SecretRef;
    /** Set by the installer for the config it created, so the console can say where it came from. */
    origin?: "installer" | "console";
    /** Admin on/off. A disabled config's external-dns instance is scaled to zero; its records stay as they are. */
    enabled: boolean;
    /** Allow the takeover of records this deployment does not own yet in these zones (8). Default false. */
    allowTakeover: boolean;
    /** Server-written runtime status, see 7.6. Never client-settable. */
    status?: DnsProviderStatus;
}

export interface SecretRef {
    backend: "openbao" | "kubernetes";
    /** OpenBao: the KV path under the deployment's integrations prefix. Kubernetes: the Secret name in the release namespace. */
    path: string;
    /** The keys present (never their values), so the console can show "set" per field. */
    keys: string[];
    /** Bumped on every credentials write: the Deployment's pod-template annotation, so a new credential rolls the pod. */
    generation: number;
}
```

### 4.2 Provider types

Each type declares its options and its secret fields. Option values are validated (types, enumerations, host names); unknown keys are refused. All values become external-dns arguments or environment variables (7.3); none is interpolated into a shell or a file path.

| Type | Options (non-secret) | Secret fields | external-dns provider |
| --- | --- | --- | --- |
| `cloudflare` | `zoneIds` (required: one per zone, passed as `--zone-id-filter`, which is what lets a token scoped to one zone work), `proxied` is never offered (mail hosts must not be proxied; MX/TXT/SRV are forced unproxied by external-dns anyway) | `apiToken` (required) | `cloudflare`, env `CF_API_TOKEN` |
| `route53` | `region`, `zoneType` (`public`/`private`, default public), `assumeRoleArn`? | `accessKeyId`, `secretAccessKey` (both or neither: neither means IRSA on the pod's ServiceAccount) | `aws`, env `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION` |
| `rfc2136` | `hosts`, `port` (53), `zone`, `tsigKeyName`, `tsigAlgorithm` (`hmac-sha256` ...), `insecure` (bool, default false); `--rfc2136-axfr` always on (sync needs it) | `tsigSecret` (base64, required unless `insecure`) | `rfc2136`, secret through env `EXTERNAL_DNS_RFC2136_TSIG_SECRET` (every flag has an `EXTERNAL_DNS_<FLAG>` variable) |
| `google` | `project` | `serviceAccountJson` | `google`, mounted file + `GOOGLE_APPLICATION_CREDENTIALS` |
| `azure` | `tenantId`, `subscriptionId`, `resourceGroup` | `clientId`, `clientSecret` | `azure`, `azure.json` (`aadClientId`/`aadClientSecret`) mounted from the Secret, `--azure-config-file` |

Facts checked against external-dns v0.23.0's source and docs (2026-10-26):

- **DigitalOcean is not offered**: its in-tree provider was removed in v0.21.0 and is only reachable through a third-party webhook provider. Webhook providers are a later addition (*Open Questions*).
- **Record kinds per provider.** MX is supported by cloudflare, aws, google and azure. **rfc2136 cannot manage MX or SRV**: it writes them but its AXFR reader skips them, so they can never be updated or deleted. For an rfc2136 config the server publishes A/AAAA/CNAME/TXT only and marks MX and SRV `unsupported` (the admin keeps those by hand).
- MX targets are `"<preference> <host>"`; SRV targets must end with `.` (v0.24.0 enforces it at admission); A/AAAA targets must not end with `.`.
- TXT values are passed to the provider raw. Whether Route 53 needs them quoted is unverified and MUST be tested per provider before that provider ships.

### 4.3 `Domain` additions

| Field | Meaning |
| --- | --- |
| `dnsProviderUid?: string` | The provider config publishing this domain's records; unset means manual. Settable by trusted role + elevation (9.4). Must name an enabled-or-disabled existing `DnsProvider` whose `zones` cover the domain. |
| `origin?: "seed" \| "console"` | `"seed"` for a domain the server created from `mail:seed:domains` (12). Unset on existing rows, which count as console-created. Server-managed. |
| `dnsPublication?: DnsPublicationStatus` | Server-written, see 4.4. Server-managed. |

`dnsProviderUid`, `origin` and `dnsPublication` join `SERVER_MANAGED_DOMAIN_FIELDS` except `dnsProviderUid`, which goes through the dedicated route in 9.4 (so it gets elevation and its own audit action) and is refused by plain `PUT`.

### 4.4 Publication status

```ts
export interface DnsPublicationStatus {
    /** The DNSEndpoint resources last written for this domain, and the generation Kubernetes gave each. */
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
    /** "published": external-dns has observed the desired state and the live lookup sees it (7.4); "pending": written, not yet live;
     * "conflict": a record of this name and kind exists that this deployment does not own (8); "unsupported": the
     * provider cannot hold this kind; "manual": the domain has no provider. */
    state: "published" | "pending" | "conflict" | "unsupported" | "manual";
}
```

`DnsRecordCheck` gains an optional `publication?: DnsRecordPublication["state"]`, so `GET /:id/dns-setup` keeps its shape and the console can show "Automatic: published / pending / conflict" next to the live check. The live check (`found`/`matches`) remains the source of truth for "is it working"; the publication state says what the server did about it.

### 4.5 `IntegrationSettings`

One singleton row (`uid: "integrations"`), seeded from config like `MailboxPolicy`:

```ts
export interface IntegrationSettings extends BaseEntity {
    giphy?: { enabled?: boolean; apiKeyRef?: SecretRef };
    stun?: { urls?: string[] };
    signingCa?: { backend?: "rfc8823" | "manual" | "none"; directoryUrl?: string; contactEmail?: string };
    dnsResolver?: { mode?: "node" | "doh-dnssec"; dohEndpoint?: string };
    pluginRegistry?: { url?: string; tokenRef?: SecretRef; namespaces?: PluginNamespace[] };
}
```

A field left unset means "use the deployment's configured value"; reset deletes the field. DNS providers are not part of this row (they are their own entity), but the console groups them under Integrations.

### 4.6 Audit actions

`DNS_PROVIDER_CREATE`, `DNS_PROVIDER_UPDATE` (details: changed option keys, `credentialsChanged: boolean`, never values), `DNS_PROVIDER_DELETE`, `DOMAIN_DNS_PROVIDER_ASSIGN` (details: from, to), `DNS_TAKEOVER` (details: provider, record names), `INTEGRATION_UPDATE` (details: section, changed keys, `secretChanged`), `INTEGRATION_RESET` (details: section, keys), `PLUGIN_SECRET_MIGRATED`.

## 5. Secret Storage

### 5.1 Interface

restapi defines the abstraction; the server registers the implementation (DI token `"SecretStore"`), the same way `BlobStore` and `DkimKeyProvider` are split:

```ts
export interface SecretStore {
    readonly backend: "openbao" | "kubernetes";
    /** Replaces the whole secret at `path` with `values`; returns the reference to persist. */
    write(path: string, values: Record<string, string>): Promise<SecretRef>;
    /** Merges `values` into the secret (unspecified keys kept): what a write-only form with some fields left alone sends. */
    patch(ref: SecretRef, values: Record<string, string | null>): Promise<SecretRef>;
    read(ref: SecretRef): Promise<Record<string, string>>;
    delete(ref: SecretRef): Promise<void>;
}
```

restapi ships `NullSecretStore` (every call throws "no secret store is configured"), so a deployment without one refuses to save credentials rather than storing them anywhere else.

### 5.2 Backends (server)

- **OpenBao** when the release was installed with it (chart `global.openbao.enabled`, set by the installer). The server authenticates with an orphan periodic token, as the installer already does for External Secrets and the PKI: `prepareOpenbao()` creates a third token, `<fullname>-openbao-integrations`, whose policy grants `create`/`update`/`read`/`delete` on `<kv mount>/data/<fullname>/integrations/*` (and the matching `metadata/`) and nothing else, mounted into the server as `mail:secrets:openbao:token` (hidden from Diagnostics). Moving all three tokens to OpenBao's Kubernetes auth method is a separate improvement (*Open Questions*). The client MUST be allowed to reach the in-cluster `http://openbao.openbao.svc:8200` address (the existing `assertSafeAddress()` rule refuses non-loopback plain HTTP), either by allowing cluster-internal service names explicitly or by giving OpenBao TLS. Credentials an external-dns pod needs reach it through an `ExternalSecret` the server writes next to the Deployment (namespace-scoped `external-secrets.io` resource, so the Role grows by that one resource), so OpenBao stays the single source and External Secrets materializes the Kubernetes Secret, as for every other release secret. Server-side consumers (Giphy key, registry token) read OpenBao directly and cache the value until the change notice in 10.2.
- **Kubernetes Secret** otherwise: one Secret per secret path in the release namespace, named `<fullname>-integration-<path>` with labels `app.kubernetes.io/managed-by: rapidmx-server`, `rapidmx.io/secret-kind: <kind>`.

The OpenBao auth role, policy and mount are the installer's job (`prepareOpenbao`), see 11.

### 5.3 Rules

- **Write-only API.** No route returns a secret value. Responses carry `{ "secret": true }` per set key, exactly as `maskSecretSettings()` does today, and accept that mask back as "unchanged". `null` clears a key.
- **Never in the database**: rows hold `SecretRef` only. Never in an audit entry, a log line or an error message.
- **Hidden from Diagnostics**: every config key the integrations layer sets that holds a secret is named on `hiddenSettings.ts`'s explicit list (`giphy:api_key` and `system:plugins:registry_token` already are; `mail:secrets:openbao:token` is added). The Diagnostics page shows the integrations layer as its own source, with secrets shown as "set".
- **Rotation**: a write bumps `SecretRef.generation`; the external-dns Deployment's pod template carries it as an annotation, so new credentials roll the pod.

### 5.4 Migrating plugin-setting secrets

Plugin settings that `isSecretSetting()` classifies as secrets move to the store:

- On save, a secret setting's value is written to the store at `plugins/<package name>/<key>` and the row keeps `{ "$secretRef": SecretRef }` in its place.
- On load, the plugin host resolves each `$secretRef` before putting the settings into the `plugins` nconf layer, so plugins see no change.
- A one-time, idempotent migration at server start moves existing plaintext secret values to the store and audits `PLUGIN_SECRET_MIGRATED` per key. It runs only when a real `SecretStore` is registered; otherwise plaintext stays and Diagnostics warns.
- The config-change hash (`PluginUtils` hash over plugin settings) uses the reference's `generation`, not the value.
- Plugin uninstall deletes its secrets.

## 6. Records Published

### 6.1 Per domain

For each enabled `Domain` with `dnsProviderUid`, exactly the records `checkDnsSetup()` recommends, built by one shared function (`buildDesiredDnsRecords(domain, ctx)` in `DnsSetupUtils.ts`) that `checkDnsSetup()` is refactored to use too, so the checklist and the publication cannot drift:

| Record | Name | Type | Value |
| --- | --- | --- | --- |
| Ownership + SPF | `<domain>` | TXT | one endpoint with both targets: `rapidmx-domain-verification=<token>` and `v=spf1 mx ~all`, plus any preserved foreign values (8.3) |
| MX | `<domain>` | MX | `10 <mx host>` |
| DKIM | `<selector>._domainkey.<domain>` | TXT | `v=DKIM1; k=rsa; p=<key>`, split into 255-byte strings by external-dns/provider as needed |
| DMARC | `_dmarc.<domain>` | TXT | as recommended |
| OpenPGP WKD | `openpgpkey.<domain>` | CNAME | `<mx host>` |
| Autodiscover | `autodiscover.<domain>` | CNAME | autodiscover host, only while the plugin is active |
| Autodiscover SRV | `_autodiscover._tcp.<domain>` | SRV | `0 0 443 <autodiscover host>`, only while the plugin is active |

Rules:

- A record whose `configured` would be false is not published (no DKIM before a key exists).
- TXT at the same name is one endpoint: external-dns manages a name and type as one record set, so ownership and SPF MUST be published together, never as two endpoints.
- The ownership TXT keeps being published after verification (it costs nothing and lets a re-verification work); it is removed with the domain.
- A disabled domain (`enabled: false`) keeps its records; deleting a domain removes them.
- An alias domain publishes its own full set, like any other.

### 6.2 The deployment's own hosts

Published through the provider config assigned to the install domain (or, when the host names fall under a different provider's zones, the provider whose `zones` cover each host name):

| Host | Type | Value |
| --- | --- | --- |
| `mail.<global.domain>` (the chart's mail host, `mail:dns:mx_hostname`) | A / AAAA | the deployment's public addresses (6.3) |
| `auth.<global.domain>` | CNAME | mail host |
| `autodiscover.<global.domain>` | CNAME | mail host (when the autodiscover plugin is active) |
| `openpgpkey.<global.domain>` | CNAME | mail host (when the openpgpkey host is on, 11.4) |

The host list is not hard-coded in the server: the chart renders it into `mail:dns:publish:hosts` (JSON list of `{ name, type: "address" | "cname", target? }`), from the same values that render the Gateway listeners and Certificates, so a host is published exactly when the chart serves it.

### 6.3 Public addresses

The A/AAAA targets come from `mail:dns:publish:addresses` (JSON list of IPv4/IPv6 literals), which the chart takes from `dns.publicAddresses`. Nothing detects these today, so the installer gains a detection step: the node's global unicast addresses from `ip -j addr`, and, when the node only has private addresses (NAT, cloud), the address seen from outside, the way coturn's `detect-external-ip` does. It prints what it found, and `--public-address <ip>` (repeatable) overrides it. The server validates them (global unicast only; private, loopback, link-local and CGNAT ranges refused) and publishes nothing for the hosts while the list is empty, surfacing that in the console.

Reading the addresses from a LoadBalancer Service's status instead is an open question (it would need `get` on `services`, which the Role could grant).

## 7. Server: `ExternalDnsManager`

### 7.1 Responsibilities

A server-side service (`server/src/dns/ExternalDnsManager.ts`) that, inside the release namespace only:

1. For each `DnsProvider`, creates or updates one external-dns `Deployment`, its credentials (`Secret`, or `ExternalSecret` with OpenBao), and nothing else (no Service: health is read from the pod, 7.6).
2. Writes, updates and deletes the `DNSEndpoint` resources that carry the desired records (7.4).
3. Deletes the Deployment and credentials of a provider config that was deleted, after its records were removed (7.5).
4. Writes publication status back to `Domain.dnsPublication` and `DnsProvider.status`.

It extends `KubeClient` with `POST`, `PUT`, `PATCH` (server-side apply, `application/apply-patch+yaml` with `fieldManager=rapidmx-server`) and `DELETE`, keeping the no-`@kubernetes/client-node` decision. Server-side apply makes every write idempotent.

### 7.2 Single writer across replicas

Exactly one replica reconciles at a time. It holds a Redis lock, `dns:publisher-lock`, built from the same primitive as `PluginRestartLock` (`SET NX PX` with a per-instance fencing value, renewal every third of the TTL through the renew-if-held script, release through delete-if-held, given back in `gracefulShutdown`'s release hook), factored out of `PluginWatcher.ts` into a shared `RedisLock`. Reusing it avoids a new `leases` grant and a second mechanism; Redis is already required. Other replicas only enqueue reconcile requests (7.5) and serve reads. Server-side apply makes a split-brain moment harmless: both writers compute the same desired state from the same database.

### 7.3 The external-dns Deployment

- Name `<fullname>-external-dns-<provider uid>`; labels `app.kubernetes.io/name: external-dns`, `app.kubernetes.io/instance: <release>`, `app.kubernetes.io/managed-by: rapidmx-server`, `rapidmx.io/dns-provider: <provider uid>`.
- **Image pinned** in the server (`mail:dns:external_dns:image`, chart value `dns.externalDns.image`), default **`registry.k8s.io/external-dns/external-dns:v0.23.0`** (released 2026-09-18; tag confirmed on registry.k8s.io). v0.24.0 (2026-10-23) is too new to pin, and adds admission validation of `DNSEndpoint`, so moving to it means re-applying the CRD. Implementation records the tag's digest and pulls by digest. The pin is bumped only deliberately (a chart release, with the CRD re-applied by the installer).
- `replicas: 1` (0 when the provider config is disabled), `strategy: Recreate`: external-dns has no leader election (its proposal is "not planned", and its own chart caps replicas at 1), and two instances with the same owner id would fight.
- Its own ServiceAccount `<fullname>-external-dns`, shared by all instances, bound to a Role allowing only `get`/`list`/`watch` on `dnsendpoints` and `update` on `dnsendpoints/status` in the namespace (created by the chart, 11.2). This is what external-dns's own chart grants with `namespaced: true`; a crd-only source needs no `nodes` or `namespaces` access. `automountServiceAccountToken: true` only on these pods.
- Liveness and readiness probes on `/healthz`, port 7979 (`--metrics-address`).
- Hardened pod: non-root, read-only root filesystem, all capabilities dropped, `seccompProfile: RuntimeDefault`, small resource requests and limits.
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
--txt-owner-id=<deployment owner id>
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

(`--crd-source-apiversion`/`--crd-source-kind` are already the defaults and are passed anyway for clarity. `--policy` has no default since v0.22.0. `--managed-record-types` defaults to A, AAAA and CNAME, so MX, TXT and SRV MUST be listed; for rfc2136, MX and SRV are left out, 4.2.)

- `--txt-owner-id` is per deployment, not per provider: `rapidmx-<release>-<namespace>-<installation id>`, where the installation id is a random value the server generates once and stores (a singleton row), so two deployments sharing a zone never claim each other's records. It MUST NOT change for the life of the deployment.
- `--txt-prefix` with `%{record_type}` and a trailing `.` is required: without it the ownership record for an apex record (`mx-example.com`) falls outside the zone, and the registry's TXT cannot sit next to a CNAME at the same name (`openpgpkey.`, `autodiscover.`, `auth.`). With it, the MX at `example.com` is owned by a TXT at `rmx-mx.example.com`. The prefix MUST never change after a deployment starts publishing, or every ownership record is orphaned.
- `--policy=sync` lets deletions happen; `--domain-filter` plus the TXT registry keep it to this deployment's own records in the provider config's zones.
- Credentials come only from the Secret (env `valueFrom.secretKeyRef` or a mounted file), never as arguments, so they never appear in the Deployment spec, `ps` output or the console.

### 7.4 `DNSEndpoint` resources

- One `DNSEndpoint` per domain (`<fullname>-domain-<domain uid with dots as hyphens, hashed suffix when too long>`) holding all of its records, and one for the deployment's own hosts (`<fullname>-hosts`), so a domain's records are added and removed as one resource.
- Labels: `rapidmx.io/dns-provider: <provider uid>` (what `--label-filter` selects), `rapidmx.io/domain: <domain uid>`, `app.kubernetes.io/managed-by: rapidmx-server`, `app.kubernetes.io/instance: <release>`.
- Reassigning a domain to another provider config rewrites the label: the old instance sees its endpoint vanish and deletes the records it owns (sync policy); the new one creates them. The console warns that this briefly removes the records.
- `spec.endpoints[]`: `dnsName`, `recordType`, `targets`, `recordTTL` (`mail:dns:publish:ttl`, default 300; Cloudflare needs at least 120), and `providerSpecific` only where a type needs it (Cloudflare `cloudflare/proxied: "false"` on A/AAAA/CNAME explicitly, the v0.23 prefix-free name; mail hosts must never be proxied). At most 1000 endpoints and 1000 targets per resource (v0.24 validation), far above what one domain needs.
- `status.observedGeneration` is written by external-dns when it **reads** the resource, not when the provider has applied it. It only tells the server that the right instance picked the change up. "Published" therefore means: observed by external-dns **and** the live check (`checkDnsSetup()`'s `matches`) sees the value. Observed but not yet live is "pending"; still not live after several intervals is reported with the instance's last error.

### 7.5 Reconciliation

A reconcile computes the full desired state from the database and applies the difference. Triggers, each enqueuing a reconcile through Redis pub/sub (`rapidmx:dns:reconcile`, payload: provider uid or domain uid), which the leader drains, coalescing duplicates:

| Trigger | Scope |
| --- | --- |
| `Domain` create, update (`enabled`, `dkimSelector`, `dkimPublicKey`, `dmarcPolicy`, `dmarcReportEmail`, `aliasOf`), delete | that domain |
| `dnsProviderUid` assignment | that domain, old and new provider |
| DKIM key created or backfilled (`ensureDkimFields`, `dnsSetup()` backfill) and a future rotation | that domain |
| Autodiscover plugin enabled/disabled, `mail:autodiscover:public_url` change | all domains |
| `DnsProvider` create, update, credentials change, enable/disable, delete | that provider's Deployment and endpoints |
| Server start (leader acquired) | everything |
| Periodic resync (`mail:jobs:dns_publication:schedule`, default every 10 minutes) | everything |

restapi emits the domain events (it owns the routes) through an injected `DnsPublisher` (DI token, `NullDnsPublisher` by default, so restapi alone and a non-Kubernetes deployment behave exactly as today); the server registers the real one, which enqueues.

Ordering for deletion: delete the domain's `DNSEndpoint`, wait for external-dns to remove the records (observed by its next sync and the live check, bounded by a timeout), then nothing else is needed. Deleting a provider config requires that no domain is assigned to it (409 otherwise), then removes its hosts endpoint, waits one interval, then removes its Deployment and credentials.

### 7.6 Health and status

The leader records, per provider, in `DnsProvider.status`:

- `deployment`: ready replicas, image, last rollout time (from the Deployment status).
- `pod`: phase, restarts, last termination reason, from `pods` with the provider label (already readable with the Diagnostics Role).
- `lastSyncError`: the most recent `level=error` line, parsed from the pod's JSON log (`pods/log`, a new `get` grant). Credentials are not expected in it, but the line is still passed through the Diagnostics value scrubber before it is stored. Reading the pod's `/metrics` on 7979 instead (which needs pod-IP reachability from the server) is an open question.
- Per-endpoint `observedGeneration`.

The console shows these on the provider's page and on each domain's DNS panel. Diagnostics lists each external-dns pod with the other containers.

## 8. Takeover of Existing Records

### 8.1 The problem

external-dns's TXT registry only changes records it owns, and it has no adopt flag or annotation (`--migrate-from-txt-owner` only moves records between two of its own owner ids). Its planner (`plan.go`, v0.23.0) is stricter than "per record":

- Updates and deletes of records with another owner, or none, are silently filtered out.
- **Creates are skipped for the whole name** when any existing record of a managed type at that name is not owned. An unowned SPF TXT at the apex therefore also blocks the MX at the apex. The skip is logged at debug level only; the metric `external_dns_registry_skipped_records_owner_mismatch_per_sync` counts it.
- A TXT value that is not an ownership record is treated as an ordinary unowned record and never deleted.

So publishing silently does nothing for exactly the names an existing domain already uses (the apex with MX and SPF, `_dmarc`), and for any name next to them.

### 8.2 Rule

Takeover is **opt-in per provider config** (`DnsProvider.allowTakeover`, default false; installer flag `--dns-takeover`) and, even then, only for names and types this deployment wants to publish. Without it, such a record's publication state is `conflict`, and the console shows the existing value next to the wanted one with a "Take over" action for that domain (trusted role + elevation, audited `DNS_TAKEOVER`).

### 8.3 Mechanism

Provider-agnostic, using the same pinned external-dns image instead of per-provider API code in the server:

1. The leader detects conflicts itself, since external-dns reports them only as a metric: for each desired name it resolves the current records of every managed kind through the configured `DnsResolver` and its ownership TXT (`rmx-<type>.<name>`). A record present without this deployment's ownership value is a conflict.
2. **Foreign values are preserved where a record set is shared.** external-dns manages a name and type as one set (Route 53 upserts all targets; Cloudflare, Google and Azure are expected to behave alike; rfc2136 removes the old set's values on update), so a value left out of the desired endpoint is deleted on takeover. At the apex TXT set, every existing value that is not an SPF record and not a `rapidmx-domain-verification=` value (Google/Microsoft site verification, other tokens) is carried into the desired endpoint as a preserved target (`Domain.dnsPublication.preservedTxt`), and remains published until an admin removes it in the console. An existing SPF record is replaced by the recommended one only when it lacks `mx`; otherwise it is kept verbatim (it may carry `include:`s the admin needs). An existing MX set is replaced (its old targets are shown in the audit entry).
3. The server runs a one-shot Kubernetes `Job` from the same image, with the provider's credentials and arguments, `--registry=noop --policy=upsert-only --once`, a dedicated label filter, and a temporary `DNSEndpoint` carrying the desired records **plus the ownership TXT records the TXT registry would have written** for them under `--txt-prefix`/`--txt-owner-id`. With the noop registry, external-dns treats every record as its own and upserts them.
4. The temporary endpoint and the Job are deleted. From then on the regular instance sees the records as owned and manages them.

The registry record written in step 3 is, per v0.23.0: name `rmx-<lowercase type>.<name>` (the `--txt-prefix` template), value `"heritage=external-dns,external-dns/owner=<owner id>,external-dns/resource=crd/<namespace>/<DNSEndpoint name>"` naming the **regular** endpoint the record will live in, not the temporary one. The format MUST be re-checked against the pinned image's `registry/txt` and `registry/mapper` code whenever the pin moves, and verified in the e2e test before any release. Doing this through the noop registry is an inference from the source, not a documented mechanism. This needs `create`/`delete` on `jobs` in the Role. If the noop-registry approach proves unworkable on a provider, the fallback is a per-provider "delete record" call from the server for the conflicting names only (*Open Questions*).

### 8.4 Uninstall

`single_node_install.sh --uninstall` deletes every `DNSEndpoint` labelled for the release, waits until each external-dns instance has synced (bounded; it checks the live DNS for the hosts' records), then removes the release. Preserved foreign TXT values cannot be preserved through deletion of the apex TXT set; uninstall therefore re-publishes the apex set without the RapidMX values through the same noop one-shot Job before deleting it, or tells the operator which values to restore when that fails. `--keep-dns` skips record removal.

## 9. Integrations API (restapi, mounted by the server)

All routes: `@RequiresTrustedRole()` plus `assertAdminScope()` (elevation) for every write; reads are trusted role. Every write is audited (4.6) with keys, never secret values.

### 9.1 `system/dns-providers`

| Route | Behaviour |
| --- | --- |
| `GET /` | List, secrets masked, with `status`. |
| `GET /types` | The provider types, their option schemas and secret fields (drives the console form). |
| `POST /` | Create. Body: `name`, `type`, `zones`, `options`, `credentials` (write-only), `allowTakeover`. Validates the type schema; zones must be valid host names; credentials written to the `SecretStore` before the row; 400 when no secret store. |
| `PUT /:id` | Update; `credentials` keys omitted or given as the mask are unchanged, `null` clears. `type` cannot change. Narrowing `zones` is refused while an assigned domain falls outside them. |
| `POST /:id/test` | Leader runs a short `--dry-run --once` Job with the config and reports whether it authenticated and found the zones. |
| `POST /:id/takeover` | Body: `domainUid`, optional record list; runs 8.3. |
| `DELETE /:id` | 409 while any domain is assigned; then 7.5 deletion. |

### 9.2 `system/integrations`

`GET` returns each section's effective values, `defaults` (from config on every request, as in 2.4), `source` per field (`"admin"` or `"deployment"`), secrets as masks. `PUT /:section` updates one section; `POST /:section/reset` (body: optional keys, all when omitted) deletes the admin values so the deployment default applies.

| Section | Fields and validation | Config key(s) it overrides | Today |
| --- | --- | --- | --- |
| `giphy` | `enabled`, `apiKey` (secret) | `giphy:api_key` | config only, plugin-protected |
| `stun` | `urls`: 0 to 10 `stun:`/`stuns:` URIs with host and optional port | new `integrations:stun:urls` | hard-coded in the meet plugin's `IceServerUtils` |
| `signingCa` | `backend` (`rfc8823`/`manual`/`none`), `directoryUrl` (https only), `contactEmail` | `mail:pki:signing_enrollment:backend`, `mail:pki:rfc8823:directory_url`, `mail:pki:rfc8823:contact_email` | config only |
| `dnsResolver` | `mode` (`node`/`doh-dnssec`), `dohEndpoint` (https only) | `mail:dns:resolver`, `mail:dns:doh:endpoint` | config only |
| `pluginRegistry` | `url` (https only), `token` (secret), `namespaces` (validated with `normalizePluginNamespaces()`) | `system:plugins:registry`, `system:plugins:registry_token`, `system:plugins:namespaces` | config only |

TURN stays in the Meet plugin's settings. Everything that is deployment infrastructure (blob/S3, mail transport and SES, ingest secret, OpenBao PKI, rspamd/ClamAV, auth-server, telemetry, Let's Encrypt, OpenSearch) stays Helm/config only.

Changing `dnsResolver` changes how every DNS check, verification and key discovery resolves; changing `signingCa` affects new enrollments only; changing `pluginRegistry` affects the next plugin install or update only. The console states these consequences next to each section.

### 9.3 Validation of URLs

Every URL field is parsed, must be `https:` (except STUN URIs), must have a host, and the host must not resolve to a private, loopback or link-local address at save time (the same SSRF stance as the rest of the server's outbound fetches).

### 9.4 Assigning a domain

`PUT mail/domains/:id/dns-provider` with `{ dnsProviderUid: string | null }`: trusted role + elevation, checks the provider's zones cover the domain, audits `DOMAIN_DNS_PROVIDER_ASSIGN`, enqueues reconciles for both providers. Setting `dnsProviderUid` through plain `PUT`/`PUT /:id/:property` is refused (403), as for the other server-managed fields.

## 10. Live Application

Today nothing is live (2.6): every value is read at startup, and saving a plugin setting rolls every replica's worker. Integrations could reuse that rolling restart (include the `IntegrationSettings` version in the state hash). That costs a restart of every replica for a Giphy key change, so it is the **fallback** for a consumer that cannot be made live in the first release, not the design.

### 10.1 The integrations config layer

The server adds an nconf layer `integrations` directly below `plugins` (so a saved integration wins over environment and defaults, and a plugin still can never write these keys since they stay in `CORE_CONFIG_NAMESPACES`; `integrations` itself is added to that list). On start and on every change notice, the server rebuilds the layer from the `IntegrationSettings` row, resolving secret references from the `SecretStore`.

### 10.2 Propagation

A write publishes `rapidmx:integrations:changed` (row version) on Redis; every replica rebuilds the layer and then notifies the consumers below. A replica that misses a message catches up on the periodic resync (it compares the row version).

### 10.3 Consumers

`@Config` fields are assigned once at construction, so each consumer changes to read at use time or to rebuild on the change notice:

| Setting | Consumer | Change |
| --- | --- | --- |
| Giphy | `server/src/routes/BaseGiphySearchRoute.ts` (`@Config("giphy:api_key")`) | Read the key per request from config (cheap: the layer is in memory). |
| STUN | meet plugin `src/util/IceServerUtils.ts` (`DEFAULT_STUN_SERVERS`: Google and Cloudflare, hard-coded; TURN comes from `mail:videoconf:turn:*` through `@Config` on `BaseVideoMeetingRoute`) | The plugin reads `integrations:stun:urls` per ICE-server request, falling back to its built-in list when empty. Needs a meet-plugin release; plugins may read core keys but not save them (to confirm, *Open Questions*). |
| Signing CA | server `registerCoreProviders` / `configDrivenBackend` choosing `Rfc8823AcmeSigningCertificateEnrollment` | Register a delegating enrollment provider that resolves the backend from config at each enrollment start; in-flight enrollments keep the backend they started with. |
| DNS resolver | `DohDnssecDnsResolver` / node resolver registered as `"DnsResolver"` | Register a delegating `DnsResolver` that holds the current implementation and swaps it on the change notice. Cached answers are dropped on a swap. |
| Plugin registry | `PluginHost` (reads `system:plugins:*` at load, `registryFor()`) and `BasePluginRoute` (`@Config` copies) | Both build `NpmRegistryClient` per operation from current config instead of from startup copies. |
| DNS providers | `ExternalDnsManager` | Reconcile (7.5). |

No setting requires a restart. Each consumer gets a test proving a change applies without one.

## 11. Chart and Installer (server)

### 11.1 Values

```yaml
dns:
  publishing:
    enabled: false            # set by the installer when --dns-provider is used
  publicAddresses: []         # A/AAAA targets for the mail host
  externalDns:
    image: registry.k8s.io/external-dns/external-dns:<pin>
    resources: {}
  ttl: 300
mail:
  seed:
    domains: []               # see 12; defaults to global.domain + postfixBridge.domains
```

### 11.2 RBAC (namespace Role only)

When `dns.publishing.enabled`, the chart adds to the server's ServiceAccount (which it then creates even without IRSA) a Role `<fullname>-dns-publishing`:

| apiGroups | resources | verbs |
| --- | --- | --- |
| `apps` | `deployments` | get, list, watch, create, update, patch, delete |
| `""` | `secrets` | get, list, create, update, patch, delete (no `watch`) |
| `externaldns.k8s.io` | `dnsendpoints` | get, list, watch, create, update, patch, delete |
| `batch` | `jobs` | get, list, create, delete |
| `""` | `pods`, `pods/log` | get, list |
| `external-secrets.io` | `externalsecrets` | get, list, create, update, patch, delete (only with OpenBao) |

and the external-dns ServiceAccount and its Role (7.3). `secrets` access in the release namespace means the server can read the chart's other Secrets; it already receives most of them as environment, so this adds no real exposure, but `resourceNames` cannot be used for `create`, so restricting to the server-managed Secrets is only possible for `get`/`update`/`delete` (do so). No ClusterRole anywhere.

### 11.3 CRD

A CRD is a cluster-scoped object (the `DNSEndpoint` resources themselves are namespaced), so the installer installs `dnsendpoints.externaldns.k8s.io`, like cert-manager's CRDs, from the pinned version's `config/crd/standard/dnsendpoints.externaldns.k8s.io.yaml`, vendored in the server repo and applied with `kubectl apply --server-side=true`. The chart does not ship it in `crds/` (Helm never upgrades those, and a chart installer is not expected to hold cluster-wide rights). With `dns.publishing.enabled` and the CRD missing, the server reports publishing as unavailable rather than failing to start.

### 11.4 Installer flags

- `--dns-provider <type>` (env `DNS_PROVIDER`): turns publishing on, installs the CRD, and creates the first provider config with `zones` = the zone of `--domain` (or `--dns-zone <zone>` when the domain is below the zone apex). For Cloudflare the installer looks up the zone id with the token.
- Credentials: `--dns-credentials-file <path>` (a `KEY=value` file, read once) or the provider's own environment variables (`CF_API_TOKEN`, `AWS_ACCESS_KEY_ID` ...), never a command-line value (it would land in shell history and `ps`). The installer writes them to OpenBao (with `--openbao`) or to the Kubernetes Secret, and passes only the reference to the chart (`mail:dns:bootstrap_provider`, JSON: `{ name, type, zones, options, secretRef }`), which the server turns into the `DnsProvider` row once (origin `installer`) at startup, idempotently.
- `--dns-takeover`: sets `allowTakeover` on that config. JP approved this for powerlevel.gg.
- `--keep-dns` for `--uninstall` (8.4).
- `prepareOpenbao` additionally enables Kubernetes auth (if not on), and creates the policy and role from 5.2 bound to the server's ServiceAccount in the release namespace.
- The final message: with a provider, lists the records being published and how to watch them; without, lists the records to add per host and per domain (the beta.46 message, kept).

### 11.5 The openpgpkey host: on whenever possible

- **A provider manages the install domain** (`dns.publishing.enabled`): the chart default for `mail.wkd.openpgpkeyHost.enabled` becomes on, the CNAME is published with the other hosts, and the Certificate is requested only after the record is published. To avoid Helm `--wait` blocking on the Certificate before external-dns has run, the installer waits for the CNAME to resolve (bounded) before the `helm upgrade` that adds the host, using a two-step install (first install without the host, then enable it). The alternative, cert-manager's DNS-01 solver against the same provider, is an open question.
- **No provider**: the installer enables the host when `openpgpkey.<domain>` already resolves to the server (CNAME to the mail host, or the same addresses), else leaves it off and prints the record to add (`--openpgpkey-host` still forces it on).
- **Admin console**: the domain's DNS panel warns when `openpgpkey.<domain>` does not resolve to this deployment, for every domain, with or without a provider.

## 12. Domain Seeding

### 12.1 Config

`mail:seed:domains`: a list, each entry either a string (the domain name) or an object:

```ts
interface SeedDomainEntry {
    name: string;
    /** The DnsProvider to assign: its `uid`, or the reserved value "bootstrap" for the installer's provider config. */
    dnsProvider?: string;
    dmarcPolicy?: "none" | "quarantine" | "reject";
    dmarcReportEmail?: string;
    /** Another seeded or existing domain this one aliases. */
    aliasOf?: string;
}
```

The chart renders it into the service ConfigMap as a JSON string (`mail__seed__domains: {{ $list | toJson | quote }}`), the same way `cors__origins` is passed. The values list `mail.seed.domains` defaults (when empty) to `global.domain` plus each name in `postfixBridge.domains` (de-duplicated), each with `dnsProvider: "bootstrap"` when `dns.publishing.enabled`. The installer's `--mail-domains` therefore feeds it without a new flag. `mail:seed` is added to `CORE_CONFIG_NAMESPACES`/`PROTECTED_PLUGIN_SETTING_KEYS`. (`mail:domains` already exists in that list; Phase 1 checks what reads it and whether it should be the key instead.)

### 12.2 Validation

Each entry is validated on its own with the same rules as `BaseDomainRoute.create()` (normalized name, `DOMAIN_NAME_PATTERN`, DMARC policy, alias rules). An invalid entry, an unknown provider, or a provider whose zones do not cover the name is **logged as a warning and skipped** (the domain without the provider, when only the provider is wrong); it never stops the server. Duplicates: the first entry wins.

### 12.3 Behaviour

At startup, after migrations, `DomainSeeder` (restapi `src/util/DomainSeedUtils.ts`, run by the server):

- **Creates a domain only when it is absent and was never seeded before.** The names seeded so far are recorded in the setup singleton (`SetupState.seededDomains: string[]`, append-only). A name on that list is never created again, so a domain the admin deleted stays deleted even when the chart still lists it, and even after a `purge` delete removed every trace of the row.
- **Never overwrites an existing domain** (seeded or not): the admin's later edits (DMARC policy, provider assignment, enabled) win. An existing domain created by hand is recorded as seeded without change.
- **A name removed from the list is not deleted** from the server; it stays like any other domain.
- Creates through the same code path as `create()` (verification token, DKIM key via `DkimKeyProvider`, audit entry `DOMAIN_CREATE` with `details.origin: "seed"` and no user), sets `origin: "seed"`, and assigns the provider directly (no elevation: the deployment's own config is the authority).
- **Multi-replica safety**: the create is keyed by `uid` = name, so a concurrent create by another replica fails with a collision, which the seeder treats as "already there"; the `seededDomains` append uses the setup row's optimistic version with the same retry `BaseSetupRoute` already uses. Seeding runs on every replica and is idempotent; no lock is needed.

### 12.4 Verification of a seeded domain

- **With a provider**: the domain's ownership TXT is published with its other records, so `DomainVerificationJob` (or `POST /:id/verify`) verifies it within minutes, with no admin action.
- **Without one**: it stays unverified until the admin publishes the TXT record, exactly like a domain added by hand.
- A reserved-TLD domain starts verified, as today.

### 12.5 Setup wizard

- `BaseSetupRoute.toStatus()`: "no domains" becomes "no domains other than seeded ones" (`origin !== "seed"`), so a fresh install with seeded domains is still sent to the wizard, and an existing deployment with hand-made domains is still never pulled into it.
- The wizard's `domain` step lists the seeded domains as already added ("Added from your installation"), each with its DNS panel: "Published automatically by <provider>" and per-record states, or the manual checklist. Adding more domains stays available. The step no longer blocks on "add a domain" when a seeded one exists.
- The installer's final message changes from "Add each domain in the admin console" to "Your domains are already in the admin console", followed by either the records being published or the records to add.

## 13. Console UX (web-client)

- **Integrations** (new admin section, `apps/admin/integrations`): one page per area, each a form following the policy pages' pattern (per-field "Reset to deployment default", the deployment value shown beneath, elevation prompt on save):
  - **DNS providers**: list with type, zones, status (Running / Not ready / Error with the last error / Disabled), assigned domain count. Create/edit form generated from `GET /types`; write-only credential fields ("Set" with a Replace button); "Test connection"; "Allow taking over existing records" switch with an explanation.
  - **Giphy**, **STUN servers**, **S/MIME signing CA**, **DNS resolver**, **Plugin registry**.
- **Domains**: a "DNS provider" select per domain (Manual, or each provider whose zones cover it). The DNS list gets a column "Published" with Automatic: published / pending / conflict (with "Take over") / unsupported, or Manual, beside the existing live check. An unreachable `openpgpkey.` host shows a warning.
- **Setup wizard**: as in 12.5.
- **Diagnostics**: external-dns pods per provider; the integrations config layer as a source; secrets shown only as "set".

## 14. Security Considerations

- **Credential exposure.** DNS credentials can redirect a domain's mail and obtain certificates for it. They live only in the secret store, are written once and never read back through the API, are absent from logs, audit entries, Diagnostics and Deployment specs, and reach only the external-dns pod for their own provider (one Secret per provider, mounted by that Deployment only). Recommend in the console: tokens scoped to DNS edit on the listed zones only. For Cloudflare: Zone:Zone:Read and Zone:DNS:Edit on the one zone, with its zone id in the config, since `--zone-id-filter` makes external-dns fetch the zone by id instead of listing all zones.
- **Who can publish.** Creating providers, changing credentials, assigning a domain, taking over records and changing integrations all need a trusted role and an elevated token, and are audited. Adding a domain (trusted role, as today) can now create public DNS records automatically, but only inside the zones an elevated admin attached to a provider config.
- **Zone confinement.** A provider config can only touch its zones: `--domain-filter` in external-dns, the zone check on assignment and on seeding, and the credentials' own scope. The TXT registry and the per-deployment owner id keep each deployment to its own records within a zone it shares.
- **Ownership verification.** When the server publishes its own verification TXT, verification proves that this deployment holds credentials able to edit the zone, which is at least as strong as the admin pasting the record by hand. It no longer proves that a separate human acted; that is acceptable because creating the provider config already required an elevated admin. A domain assigned to a provider is still only verified by the public DNS lookup, never by the server's own knowledge that it wrote the record.
- **Takeover** can overwrite records other systems depend on. Opt-in per provider, per-domain confirmation in the console, preserved foreign TXT values, and an audit entry listing the old values.
- **Kubernetes rights.** The server gains write access to Deployments, Secrets and Jobs in its own namespace, which is a namespace-admin-like capability: a compromise of the server process could run arbitrary pods in the namespace. Mitigations: images other than the pinned external-dns image are refused by the manager itself; a ValidatingAdmissionPolicy restricting images is out of reach without cluster rights (*Open Questions*). This is the main cost of running external-dns from the server instead of the chart.
- **SSRF.** URL fields are validated as in 9.3; the DoH endpoint and registry URL are https only.

## 15. Failure Modes

| Failure | Behaviour |
| --- | --- |
| CRD not installed | Publishing reported unavailable in the console and Diagnostics; domains behave as manual. |
| Missing RBAC (chart value off, or an old chart) | Same, with the missing permission named (as `KubeClient`'s Diagnostics hint does today). |
| Bad credentials / provider API down | external-dns logs errors and retries; the provider shows Error with the last error; records keep their last state. |
| Record conflict | `conflict` state with the existing value; nothing overwritten unless takeover. |
| Provider does not support a record kind | `unsupported` for that record; the others publish. |
| Leader lost mid-reconcile | Next leader recomputes from the database; writes are idempotent. |
| Secret store unavailable (OpenBao sealed) | Credential writes fail with 503; running instances keep their Kubernetes Secret; server-side secrets keep their cached value and warn. |
| Domain deleted while its records are pending | Endpoint deletion wins; external-dns removes whatever it created. |
| Two deployments share a zone | Separate owner ids; each manages its own records; a name both want is a conflict for the second. |
| External-dns removed by hand | Next reconcile re-creates it. |
| Public addresses empty or private | Hosts not published, console says why. |

## 16. Testing

- **restapi unit + real-DB (Mongo and SQL)**: `DnsProvider` CRUD and validation per type; masks and write-only behaviour; elevation and audit on every write; `buildDesiredDnsRecords()` equals `checkDnsSetup()`'s recommendations for every combination (DKIM missing, autodiscover on/off, alias); apex TXT merge with preserved values; `IntegrationSettings` seed/defaults/reset; domain assignment rules (zone coverage, 403 on plain PUT); `DomainSeeder` (create once, never re-create after delete or purge, never overwrite, skip invalid entries with a warning, concurrent seeding by two instances); `toStatus()` with seeded domains; plugin secret migration idempotence.
- **server unit**: `ExternalDnsManager` against a fake `KubeTransport` (Deployment/Secret/DNSEndpoint manifests are golden-tested; args per provider; no credential in any manifest or log); lease acquisition and handover; reconcile triggers and coalescing; each live-applied consumer changes without restart; `SecretStore` backends against a fake OpenBao and fake API server.
- **chart**: `helm template` tests for the Role (namespace only, no ClusterRole), the values-to-config rendering of `mail__seed__domains` and `mail__dns__publish__*`, the openpgpkey default rules.
- **CI**: a kind cluster job with the CRD, the chart and external-dns pointed at a throwaway in-cluster bind9 (`rfc2136` with TSIG and AXFR), exercising create, update, DKIM change, delete, provider reassignment, conflict, takeover with preserved TXT values, and uninstall cleanup. rfc2136 cannot manage MX or SRV (4.2), so CI covers A/AAAA/CNAME/TXT and the `unsupported` state; MX and SRV are covered only by the Cloudflare e2e.
- **e2e on powerlevel.gg** (JP's host) with Cloudflare, local helm package first, release only after it passes:
  1. Install with `--dns-provider cloudflare --dns-takeover`, credentials from a file on the host only.
  2. Verify the takeover of the existing hand-made records (MX, apex TXT with SPF and any other values preserved, `_dmarc`, hosts), the ownership TXT and automatic verification of the seeded domain, the openpgpkey host on and certified.
  3. Add and delete a second domain in the console; change DMARC; reassign to manual.
  4. Check the external-dns log after deploy (no errors, no credentials logged).
  5. Uninstall with and without `--keep-dns`.
  The token is never committed or stored anywhere but the test host's OpenBao/Secret, and JP rotates it afterwards.

## 17. Implementation Plan

Process per the 2026-10-27 rules: reproduce or test first, an independent review of each diff before commit, CI green before release. Order: spec, restapi, server, web-client, powerlevel.gg e2e, release (restapi minor, web-client minor, server beta).

**restapi**
1. `SecretStore` interface + `NullSecretStore`; `SecretRef`; masks shared with plugin settings.
2. `DnsProvider` model, types registry, `BaseDnsProviderRoute`; `Domain` fields and `PUT /:id/dns-provider`; audit actions.
3. `buildDesiredDnsRecords()` and the `checkDnsSetup()` refactor; `DnsRecordCheck.publication`; `DnsPublisher` + `NullDnsPublisher` hooks in `BaseDomainRoute`.
4. `IntegrationSettings` model and `BaseIntegrationsRoute` (sections, defaults, reset, elevation, audit); `integrations` and `mail:seed` in `CORE_CONFIG_NAMESPACES`.
5. `DomainSeeder`, `SetupState.seededDomains`, `Domain.origin`, `toStatus()` change.
6. Plugin-setting secret references and the migration helper.

**server**
1. `KubeClient` write verbs and server-side apply; `RedisLock` factored out of `PluginWatcher` for the publisher lock.
2. `SecretStore` backends (Kubernetes Secret, OpenBao via Kubernetes auth + `ExternalSecret`); hidden-settings additions.
3. `ExternalDnsManager`: manifests, pinned image, reconcile queue, status, takeover Job; `DnsPublisher` implementation; periodic resync job.
4. Integrations nconf layer, change propagation, and the live consumers (Giphy, delegating resolver, delegating enrollment, per-operation registry client).
5. Run the seeder at startup; bootstrap provider from `mail:dns:bootstrap_provider`.
6. Chart: values, Roles, ServiceAccounts, `mail__seed__domains`, hosts/addresses config, openpgpkey defaults.
7. Installer: `--dns-provider`, credentials, `--dns-zone`, `--dns-takeover`, CRD install, OpenBao role, two-step openpgpkey, `--uninstall` cleanup and `--keep-dns`, final message.
8. Remove the beta.46 opt-in note from README/release notes as appropriate.

**meet-plugin**: read `integrations:stun:urls` with fallback (separate release).

**web-client**
1. Integrations section and pages; DNS provider form from `GET /types`.
2. Domains: provider select, publication column, takeover action, openpgpkey warning.
3. Setup wizard: seeded domains on the domain step.
4. Diagnostics additions.

Then the powerlevel.gg e2e (16), then the releases.

## Open Questions

1. **Takeover mechanism.** Does `--registry=noop --policy=upsert-only --once` plus pre-written ownership TXT records (8.3) reliably hand records to the TXT-registry instance on Cloudflare (and on bind9 in CI)? This is inferred from v0.23.0's source, not documented. Fallback: per-provider delete calls in the server, which means provider API code in the server. A third option is external-dns's `--registry=crd` (v0.22+, ownership kept in `DNSRecord` resources instead of TXT), not evaluated here.
2. **rfc2136 and MX/SRV.** Accept "unsupported, keep by hand" for rfc2136 (4.2), or drop rfc2136 from the first release?
3. **Route 53 TXT quoting.** Whether user TXT values must be sent quoted is unverified; test before shipping `route53`.
4. **DigitalOcean and webhook providers.** DigitalOcean is now only a third-party webhook (a sidecar image we would also have to pin and trust). Leave it out, or add a generic webhook type later?
5. **OpenBao auth.** A third periodic token (5.2, matching today's practice) or move all three tokens to OpenBao's Kubernetes auth method now? Also: allow plain HTTP to the in-cluster OpenBao service, or give OpenBao TLS?
6. **Public addresses.** Installer-detected list only (6.3), or also read from a LoadBalancer Service status (needs `get services`)? Dual-stack nodes behind NAT?
7. **openpgpkey with Helm `--wait`.** Two-step install (wait for the CNAME, then enable) versus cert-manager DNS-01 through the same provider (which would put provider credentials in cert-manager's namespace).
8. **Health source.** `pods/log` for the last error versus scraping `/metrics` on 7979.
9. **Namespace-admin exposure.** Is the server holding create rights on Deployments, Secrets and Jobs acceptable, or should the manager be a separate small controller pod with those rights, the server writing only `DNSEndpoint`s and provider configs?
10. **DKIM rotation.** It does not exist (2.3). Build it here (selector rollover: publish the new selector, wait, switch signing, retire the old after a grace period), or only reconcile on manual key changes for now?
11. **STUN in the meet plugin.** Can a plugin read a core-namespace key (`integrations:stun:urls`) through the host config, or must the host hand ICE servers to the plugin through a plugin API?
12. **`mail:domains`.** It is already a protected core namespace; check what reads it, and whether seeding should use it instead of `mail:seed:domains`.
13. **Hosts outside every zone.** When `auth.`/`mail.` fall outside every provider's zones, publish nothing for them and say so, or allow a per-host provider choice?
14. **Preserved apex TXT values on uninstall** (8.4): re-publish the foreign values through a final noop Job, or leave the apex TXT set untouched and only remove what is identifiably RapidMX's?
15. **Pin.** v0.23.0 now; when to move to v0.24.0 (admission validation, multi-value `--namespace`), which needs the CRD re-applied on upgrade.

## Resolved Decisions

From JP, 2026-10-27:

- external-dns, not OctoDNS: a Kubernetes controller with about 40 providers, touching only records it owns, reading `DNSEndpoint`s from one namespace; its CRD is an installer-level install like cert-manager's.
- Records: exactly what `checkDnsSetup()` recommends, plus the deployment's hosts (A/AAAA for the mail host to the public addresses; CNAMEs for auth, autodiscover, openpgpkey).
- Domain add/remove and DKIM changes in the console publish automatically.
- Per-domain provider ("manual" allowed), configured in the console; one external-dns Deployment per provider config, run by the server in its own namespace, with a pinned image, a credentials Secret and a label filter. The chart's Role covers deployments, secrets and dnsendpoints in the namespace only.
- Installer: `--dns-provider` plus credentials creates the first provider config and assigns the install domain, installs the CRD; uninstall removes owned records.
- openpgpkey defaults on whenever possible (11.5).
- Integrations: DNS providers, Giphy, STUN, signing CA, DNS resolver, plugin registry; TURN stays in Meet; infrastructure stays Helm/config. Typed, trusted role + elevation, audited, live-applied, reset to deployment default.
- Secrets outside the DB (OpenBao, else Kubernetes Secrets), write-only, hidden from Diagnostics; plugin-setting secrets move there too.
- The chart seeds the install's domains into the server (any number, from a config list, never deleted when removed from the list).
- Takeover of the existing powerlevel.gg records is approved for the e2e test.

## Status

Design. No code yet.
