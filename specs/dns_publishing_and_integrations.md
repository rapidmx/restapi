# RapidMX: DNS Publishing and Admin-Console Integrations

This document is the technical design for linked features across `@rapidmx/restapi`, `@rapidmx/server`, `@rapidmx/web-client`, `postfix-bridge` and `@rapidmx/meet-plugin`:

1. **DNS publishing.** RapidMX publishes every DNS record a deployment and its domains need, through [external-dns](https://github.com/kubernetes-sigs/external-dns), using per-domain DNS provider configurations an administrator manages in the admin console.
2. **DKIM rotation.** Each domain's DKIM key rotates on a schedule (and on demand), with the new selector published and observed live before signing switches to it.
3. **Integrations.** Third-party services an administrator chooses (DNS providers, Giphy, STUN, the S/MIME signing CA, the DNS resolver, the plugin registry) move from deployment-only configuration to typed, audited, live-applied settings in the admin console, with their secrets held outside the database.
4. **Domain seeding.** The domains a deployment is installed for exist in the server from its first start, instead of being added again by hand in the admin console.

The decisions this document implements were made with JP on 2026-10-27 and are not re-litigated here (see *Resolved Decisions*). It supersedes the beta.46 stopgap that made the `openpgpkey.<domain>` host opt-in.

## 1. Why

The Helm chart cannot know whether a host's DNS record exists. A feature that needs a host either breaks an install or upgrade (Helm 4's `--wait` waits on cert-manager `Certificate`s, which cannot be issued for a name without a record) or ships disabled. Today that applies to `openpgpkey.<domain>` and, equally, to `mail.`, `auth.` and `autodiscover.` and to each domain's MX, SPF, DKIM and DMARC records, all of which an operator copies by hand from the admin console's DNS checklist (`GET /mail/domains/:id/dns-setup`).

Publishing those records ourselves removes the manual step, so hosts can default on, a domain added in the admin console starts receiving mail without a trip to the registrar, and DKIM keys can finally rotate.

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
- The list of "this server's domains" at runtime is always the verified `Domain` rows (`DomainUtils.getVerifiedDomainNames()`, used by ingest, transport rules and the MTA's relay-domain lookup), never config.

### 2.3 DKIM keys and signing

- **Key custody (server).** The server registers `FsDkimKeyProvider` (`server/src/lib/registerCoreProviders.ts`): one RSA key per domain at `<mail:dkim:key_dir>/<domain>.<mail:dkim:selector>.key` (default `/var/lib/rspamd/dkim/<domain>.mail.key`), on the `<fullname>-dkim-keys` PVC (`server/helm/templates/0_config/mail-storage.yaml`). The selector is one global value for every domain.
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
- A secret setting (`isSecretSetting()`: key words, `secret: true` or `type: "password"` in the manifest) is masked in responses as `{ "secret": true }` (`maskSecretSettings()`), and sending the mask back means "left alone" (`isMaskedSecret()`).
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

Nothing reads `mail:domains` at runtime. It is on the protected-namespace lists, the doc comments of `TransportRuleUtils.buildTransportRuleContext()` and of the transport-rule `anyRecipientExternal` condition in `models/types.ts` still call the list "configured `mail:domains`" (stale: the caller passes `getVerifiedDomainNames()`), and the only writer is the server's `yarn dev` helper (`src/dev/enableDevAutoLogin.ts`), which sets `["example.com"]`. This design gives the key its meaning back (§13).

## 3. Concepts

- **DNS provider config** (`DnsProvider`): a named, admin-managed configuration of one DNS hosting account: its type (`cloudflare`, `route53`, ...), non-secret options, the zones it may touch, and a reference to its credentials in the secret store.
- **Assignment**: each `Domain` has `dnsProviderUid`, naming a provider config, or nothing ("manual": the admin publishes records by hand, exactly as today).
- **Desired state**: what the server says must be published: provider configs, their assignments and the desired records for each domain and for the deployment's own hosts. The server computes and stores it; it never writes to Kubernetes.
- **DNS controller**: a separate, single-replica pod with its own ServiceAccount and namespace Role. It reads the desired state from the server and is the only RapidMX component that creates or changes Kubernetes objects (§7).
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
    /** Allow the takeover of records this deployment does not own yet in these zones (9). Default false. */
    allowTakeover: boolean;
    /** Written only from the controller's status reports (7.7). Never client-settable. */
    status?: DnsProviderStatus;
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

Facts checked against external-dns v0.23.0's source and docs (2026-10-26):

- **DigitalOcean is not offered**: its in-tree provider was removed in v0.21.0 and is only reachable through a third-party webhook provider. DigitalOcean and webhook providers come later.
- **Record kinds per provider.** MX is supported by cloudflare, aws, google and azure. **rfc2136 cannot manage MX or SRV**: it writes them but its AXFR reader skips them, so they can never be updated or deleted. For an rfc2136 config the controller publishes A/AAAA/CNAME/TXT only, and the MX and SRV records show as **manual** (with the reason) for the admin to keep by hand.
- MX targets are `"<preference> <host>"`; SRV targets must end with `.`; A/AAAA targets must not end with `.`.
- TXT values are passed to the provider raw. Whether Route 53 needs them quoted is unverified, and is covered by its unit tests against recorded API fixtures plus a warning on the type until it is live-tested.

### 4.3 `Domain` additions

| Field | Meaning |
| --- | --- |
| `dnsProviderUid?: string` | The provider config publishing this domain's records; unset means manual. Set only through `PUT /:id/dns-provider` (10.4). Must name an existing `DnsProvider` whose `zones` cover the domain. |
| `origin?: "seed" \| "console"` | `"seed"` for a domain the server created from `mail:domains` (13). Unset on existing rows, which count as console-created. Server-managed. |
| `dnsPublication?: DnsPublicationStatus` | Written from the controller's status reports and the live check, see 4.4. Server-managed. |
| `dkimRotation?: DkimRotationState` | Rotation state, see 6.2. Server-managed. |
| `dkimManaged?: boolean` | `true` when the current key came from the `DkimKeyProvider` (rotation possible), `false` when an admin imported `dkimSelector`/`dkimPublicKey` by hand (never rotated automatically). Server-managed. |

All of them join `SERVER_MANAGED_DOMAIN_FIELDS` (refused by plain `PUT` and `PUT /:id/:property`).

### 4.4 Publication status

```ts
export interface DnsPublicationStatus {
    /** The DNSEndpoint resources the controller last applied for this domain, and what external-dns has observed. */
    endpoints: { name: string; generation: number; observedGeneration?: number }[];
    /** Per record (same identity as DnsRecordCheck: type + recordName). */
    records: DnsRecordPublication[];
    /** Foreign values kept in the apex TXT set after a takeover (9.3). */
    preservedTxt?: string[];
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
    manualReason?: "no_provider" | "kind_unsupported" | "outside_zones";
}
```

`DnsRecordCheck` gains an optional `publication?: DnsRecordPublication["state"]` (and `manualReason`), so `GET /:id/dns-setup` keeps its shape and the console can show "Automatic: published / pending / conflict" or "Manual" next to the live check. The live check (`found`/`matches`) stays the source of truth for "is it working".

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

A field left unset means "use the deployment's configured value"; reset deletes the field. DNS providers are their own entity, but the console groups them under Integrations.

### 4.6 Installation identity

A singleton row `DeploymentIdentity { installationId }`: a random 16-character value created once, the stable part of the external-dns owner id (7.4). It never changes for the life of the database.

### 4.7 Audit actions

`DNS_PROVIDER_CREATE`, `DNS_PROVIDER_UPDATE` (details: changed option keys, `credentialsChanged: boolean`, never values), `DNS_PROVIDER_DELETE`, `DOMAIN_DNS_PROVIDER_ASSIGN` (details: from, to), `DNS_TAKEOVER` (details: provider, record names, the old values), `DKIM_ROTATION_STARTED` (details: new selector, `reason: "scheduled" | "manual" | "compromised"`), `DKIM_ROTATION_SWITCHED`, `DKIM_ROTATION_RETIRED`, `DKIM_ROTATION_CANCELLED`, `INTEGRATION_UPDATE` (details: section, changed keys, `secretChanged`), `INTEGRATION_RESET` (details: section, keys), `PLUGIN_SECRET_MIGRATED`.

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
    /** Only for secrets the server itself consumes (Giphy key, registry token, plugin secrets). DNS credentials are never
     * readable by the server (5.2). */
    read(ref: SecretRef): Promise<Record<string, string>>;
    delete(ref: SecretRef): Promise<void>;
}
```

restapi ships `NullSecretStore` (every call throws "no secret store is configured"), so a deployment without one refuses to save credentials rather than storing them anywhere else.

Paths are namespaced by consumer: `dns/<provider uid>` (DNS credentials, consumed only by external-dns), `server/<name>` (Giphy key, registry token) and `plugins/<package>/<key>` (plugin secrets).

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
| Ownership + SPF | `<domain>` | TXT | one endpoint with both targets: `rapidmx-domain-verification=<token>` and `v=spf1 mx ~all`, plus any preserved foreign values (9.3) |
| MX | `<domain>` | MX | `10 <mx host>` |
| DKIM (active) | `<dkimSelector>._domainkey.<domain>` | TXT | `v=DKIM1; k=rsa; p=<key>` |
| DKIM (next / previous) | `<selector>._domainkey.<domain>` | TXT | during a rotation only (6.2) |
| DMARC | `_dmarc.<domain>` | TXT | as recommended |
| OpenPGP WKD | `openpgpkey.<domain>` | CNAME | `<mx host>` |
| Autodiscover | `autodiscover.<domain>` | CNAME | autodiscover host, only while the plugin is active |
| Autodiscover SRV | `_autodiscover._tcp.<domain>` | SRV | `0 0 443 <autodiscover host>.`, only while the plugin is active |

Rules:

- A record whose `configured` would be false is not published (no DKIM before a key exists).
- TXT at the same name is one endpoint: external-dns manages a name and type as one record set, so ownership and SPF MUST be published together, never as two endpoints.
- The ownership TXT keeps being published after verification (it costs nothing and lets a re-verification work); it is removed with the domain.
- A disabled domain (`enabled: false`) keeps its records; deleting a domain removes them.
- An alias domain publishes its own full set, like any other.
- A kind the provider cannot hold (rfc2136: MX, SRV) is left out and shown as manual (`kind_unsupported`).

`DnsRecordType` gains `dkim_next` and `dkim_previous`, so the checklist shows the extra selectors during a rotation.

### 6.2 DKIM rotation

**Components.**

- **restapi**: the rotation state on `Domain`, `DkimRotationJob`, the routes, and an extended `DkimKeyProvider` interface.
- **server**: `FsDkimKeyProvider` implements per-domain selectors and the switch.
- **postfix-bridge**: `dkim-sync.sh` signs each domain with its own selector and acknowledges the switch.

**Selectors.** Each rotation mints a new selector `rmx<yyyymmdd>` (suffix `b`, `c`, ... on a same-day collision). An existing domain keeps the global selector (`mail`) until its first rotation.

**`DkimKeyProvider` additions** (optional methods; `supportsRotation` false on `NullDkimKeyProvider`):

```ts
interface DkimKeyProvider {
    ensureKeyPair(domain: string): Promise<DkimKeyPair | undefined>;   // unchanged
    readonly supportsRotation?: boolean;
    /** Creates the key for `selector` without signing with it. Idempotent (exclusive create, as ensureKeyPair is). */
    generateKeyPair?(domain: string, selector: string): Promise<DkimKeyPair>;
    /** Makes `selector` the one the MTA signs `domain` with. */
    activate?(domain: string, selector: string): Promise<void>;
    /** The selector the MTA reports it is signing `domain` with, if it reports one. */
    signingSelector?(domain: string): Promise<string | undefined>;
    /** Deletes the private key of a retired selector. */
    deleteKeyPair?(domain: string, selector: string): Promise<void>;
}
```

**Files on the shared DKIM volume** (`FsDkimKeyProvider`, server):

- `<domain>.<selector>.key`: one per selector, as today's naming already allows.
- `<domain>.selector`: the selector to sign with, written atomically (temp file + rename) by `activate()`. Its absence means the global selector, so existing deployments are unaffected until a rotation.
- `<domain>.signing`: written by postfix-bridge after OpenDKIM has reloaded with a selector, containing that selector. `signingSelector()` reads it.

**postfix-bridge `dkim-sync.sh`** (and the init container): per domain, use `<domain>.selector` when present, else `$DKIM_SELECTOR`; copy `<domain>.<sel>.key` to `/etc/opendkim/keys/<domain>.<sel>.private`; write `KeyTable` lines `<sel>._domainkey.<d> <d>:<sel>:<path>` and `SigningTable` `*@<d> <sel>._domainkey.<d>`; after a successful `SIGUSR1` reload, write `<domain>.signing`. Old `<domain>.private` files are removed once a per-selector file exists. The bundled `postfixBridge` subchart moves in lock-step with the server chart. docker-compose (`server/docker-compose.mail.yml`) uses the same script.

**State** (`Domain.dkimRotation`):

```ts
interface DkimRotationState {
    phase: "idle" | "pending" | "switching" | "overlap";
    next?: { selector: string; publicKey: string; createdAt: Date; liveSince?: Date; reason: "scheduled" | "manual" | "compromised" };
    previous?: { selector: string; publicKey: string; retireAt?: Date };
    lastRotatedAt?: Date;
    paused?: boolean;
    lastError?: string;
}
```

**Phases**, driven by `DkimRotationJob` (`mail:jobs:dkim_rotation:schedule`, default hourly). It runs on every replica; each transition is one versioned update of the domain row, so a replica that loses the race skips:

1. **idle → pending.** Triggered when `lastRotatedAt` (or the key's creation) is older than `mail:dkim:rotation:interval_days` (default 180), or by "Rotate now". The job records `next.selector` in the row first, then calls `generateKeyPair()`. The new record `dkim_next` joins the desired state: published by the provider, or shown in the console for the admin to add ("Publish this record to finish rotating"). Signing is unchanged.
2. **pending → switching.** The job live-checks `next.selector._domainkey.<domain>` through the configured `DnsResolver`. When it matches, it sets `liveSince`. When `liveSince` is at least `mail:dkim:rotation:publish_grace_hours` old (default 48, so receivers' resolvers have dropped any negative-cached answer), it calls `activate()`, sets `dkimSelector`/`dkimPublicKey` to the new key, and moves the old one to `previous`. **A manual domain follows exactly the same rule: signing never switches before the live check passes**, however long the admin takes. The console reminds the admin after 7 days.
3. **switching → overlap.** When `signingSelector()` reports the new selector (postfix-bridge has reloaded), the job sets `previous.retireAt = now + mail:dkim:rotation:overlap_days` (default 7), so mail signed with the old key and still in queues, or re-verified later, keeps verifying. If no acknowledgement arrives within an hour (an older postfix-bridge without the acknowledgement), the job records `lastError`, keeps both selectors published, and does not start the overlap clock.
4. **overlap → idle.** At `retireAt` the old selector's record leaves the desired state (the provider deletes it; a manual domain's console says the admin may now remove it), `deleteKeyPair()` removes the old private key, and `lastRotatedAt` is set.

**Manual action.** `POST mail/domains/:id/dkim/rotate` with `{ compromised?: boolean }` (trusted role and elevation, audited) starts phase 1 now. With `compromised`, the publish grace is skipped (the switch still waits for the live check, since switching earlier makes every message fail DKIM) and the overlap is zero: the old record is removed as soon as signing is confirmed. `POST mail/domains/:id/dkim/rotation/cancel` abandons a rotation that has not switched yet (deletes the new key and its record). `PUT mail/domains/:id/dkim/rotation` with `{ paused }` stops scheduled rotation for one domain.

**Not rotated:** domains whose key was imported by hand (`dkimManaged: false`), deployments whose provider does not support rotation (`NullDkimKeyProvider`), and SES deployments (SES's Easy DKIM rotates its own keys). The console says why.

**Config:** `mail:dkim:rotation:enabled` (default true), `interval_days` (180), `overlap_days` (7), `publish_grace_hours` (48), `key_bits` (2048). These are deployment config, not Integrations.

### 6.3 The deployment's own hosts

Published through the provider config whose `zones` cover each host name:

| Host | Type | Value |
| --- | --- | --- |
| `mail.<global.domain>` (the chart's mail host, `mail:dns:mx_hostname`) | A / AAAA | the deployment's public addresses (6.4) |
| `auth.<global.domain>` | CNAME | mail host |
| `autodiscover.<global.domain>` | CNAME | mail host (when the autodiscover plugin is active) |
| `openpgpkey.<global.domain>` | CNAME | mail host (when the openpgpkey host is on, 12.5) |

The host list is not hard-coded in the server: the chart renders it into `mail:dns:publish:hosts` (JSON list of `{ name, type: "address" | "cname", target? }`), from the same values that render the Gateway listeners and Certificates, so a host is published exactly when the chart serves it. **A host outside every provider's zones stays manual** (`manualReason: "outside_zones"`) and is marked so in the console and in the installer's final message.

### 6.4 Public addresses

The A/AAAA targets come from `mail:dns:publish:addresses` (JSON list of IPv4/IPv6 literals), which the chart takes from `dns.publicAddresses`. The installer detects them: the node's global unicast addresses (`ip -j addr`), and, when the node has only private addresses (NAT, cloud), the address seen from outside, the way coturn's `detect-external-ip` does. It prints what it found, and `--public-address <ip>` (repeatable) overrides detection. The server validates the list (global unicast only; private, loopback, link-local and CGNAT ranges refused) and publishes nothing for the hosts while it is empty, saying so in the console.

## 7. The DNS Controller

### 7.1 Why a separate pod

Creating Deployments, Secrets and Jobs is a namespace-admin-like right: whoever holds it can run arbitrary pods in the namespace. The mail server is the large, internet-facing process. It therefore keeps **only its existing read-only Kubernetes access** (the Diagnostics Role) and records desired state; a small controller holds the write rights and nothing else (no database, no Redis, no plugins, no mail).

### 7.2 Where it lives

- **Same image as the server, separate command** (`node dist/dns-controller/main.js`), source in `server/src/dns-controller/`. Server and controller always run the same version (lock-step), share the `KubeClient`, manifest builders and types, and there is no second image to build, scan and pin. The controller's entrypoint loads none of the server's routes, datastores or plugins.
- Chart template `helm/templates/1_deployments/dns-controller.yaml`, rendered when `dns.publishing.enabled`: a Deployment with `replicas: 1` (not configurable), `strategy: Recreate`, its own ServiceAccount `<fullname>-dns-controller`, a hardened pod (non-root, read-only root filesystem, no capabilities, `RuntimeDefault` seccomp, small requests/limits), and a ClusterIP Service on port 8080 for the server's calls (7.3), with a NetworkPolicy admitting only the server pods.
- **Single writer.** One replica with `Recreate`, plus a `coordination.k8s.io` `Lease` (`<fullname>-dns-controller`, renewed every 10 s, 30 s duration) that the controller must hold before writing, so a stuck old pod and a new one can never write together.

### 7.3 How it gets desired state: an internal API on the server

The controller reads desired state **through the server's internal API**, not from the database:

- **Least privilege.** A database connection would give the pod that can run arbitrary pods read access to every mailbox. The API gives it exactly the desired state.
- **One source of record-building logic.** `buildDesiredDnsRecords()`, assignment rules and the rotation state stay in restapi and the server; the controller only turns desired state into manifests.
- Both backends (Mongo, SQL) work without the controller knowing either.

Routes (restapi `BaseDnsDesiredStateRoute`, mounted by the server under `/internal/dns`, outside the public Gateway like `/internal/mta`):

| Route | Purpose |
| --- | --- |
| `GET /internal/dns/desired-state?since=<version>` | The full desired state: provider configs (with `SecretRef`s, never values), endpoints per domain and for the hosts, the owner id, the image pin, and queued operations (test, takeover). With `since`, a long poll that answers when the version moves past it, or after 55 s. |
| `PUT /internal/dns/status` | The controller's report: per provider (Deployment readiness, metrics, last error) and per endpoint (applied generation, `observedGeneration`), per operation (result). |

In the other direction, the controller serves `PUT /secrets/:path` and `DELETE /secrets/:path` on its Service, used only for the Kubernetes-Secret backend (5.2).

**Authentication: projected ServiceAccount tokens, no shared secrets.** Each side presents a projected ServiceAccount token with a dedicated audience (controller to server: `rapidmx-internal-dns`; server to controller: `rapidmx-dns-controller`; 1 hour, rotated by the kubelet). The receiver verifies the signature against the cluster's service-account issuer keys (`GET /openid/v1/jwks` on the API server, readable by every ServiceAccount through Kubernetes's default `system:service-account-issuer-discovery` binding), the audience, the expiry, and the exact subject (`system:serviceaccount:<namespace>:<fullname>-dns-controller`, or the server's). Keys are cached and refetched on an unknown `kid`. No TokenReview (it would need a ClusterRole) and no long-lived secret.

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

- One `DNSEndpoint` per domain (`<fullname>-domain-<domain uid with dots as hyphens, hashed suffix when too long>`) holding all of its records, and one for the hosts (`<fullname>-hosts-<provider uid>`).
- Labels: `rapidmx.io/dns-provider: <provider uid>` (what `--label-filter` selects), `rapidmx.io/domain: <domain uid>`, `app.kubernetes.io/managed-by: rapidmx-dns-controller`, `app.kubernetes.io/instance: <release>`.
- Reassigning a domain to another provider rewrites the label: the old instance deletes the records it owns (sync policy), the new one creates them. The console warns that this briefly removes them.
- `spec.endpoints[]`: `dnsName`, `recordType`, `targets`, `recordTTL` (`mail:dns:publish:ttl`, default 300; Cloudflare needs at least 120), and `providerSpecific` only where needed (Cloudflare `cloudflare/proxied: "false"` on A/AAAA/CNAME).
- Writes use server-side apply (`fieldManager=rapidmx-dns-controller`), so every write is idempotent. `KubeClient` gains `PATCH` (apply), `PUT`, `POST` and `DELETE`, used only by the controller.
- `status.observedGeneration` is written by external-dns when it **reads** the resource, not when the provider has applied it. "Published" therefore means observed **and** seen by the server's live check. Observed but not live is "pending"; still not live after several intervals is shown with the instance's last error.

Deletion: a deleted domain's endpoint is deleted; external-dns removes what it owns on its next sync. A provider config can be deleted only when no domain is assigned to it (409 otherwise); the controller then deletes its hosts endpoint, waits one interval, and deletes the Deployment and its credentials.

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
- **Creates are skipped for the whole name** when any existing record of a managed type at that name is not owned. An unowned SPF TXT at the apex therefore also blocks the MX at the apex. The skip is logged at debug level only; a metric counts it.
- A TXT value that is not an ownership record is never deleted.

### 9.2 Rule

Takeover is **opt-in per provider config** (`allowTakeover`, default false; installer flag `--dns-takeover`) and only for names this deployment wants to publish. Without it, a conflicting record's state is `conflict`, and the console shows the existing value next to the wanted one with a "Take over" action for that domain (trusted role and elevation, audited `DNS_TAKEOVER`).

### 9.3 Mechanism

1. **Detection (server).** For each desired name, the server resolves the current records of every managed kind and the ownership TXT (`rmx-<type>.<name>`). A record present without this deployment's ownership value is a conflict.
2. **Foreign values are preserved where a set is shared.** external-dns replaces a name and type as one set, so a value left out of the desired endpoint is deleted on takeover. At the apex TXT set, every value that is not SPF and not a `rapidmx-domain-verification=` value (site verifications, other tokens) is kept as a preserved target (`dnsPublication.preservedTxt`) until an admin removes it in the console. An existing SPF is replaced only when it lacks `mx`; otherwise it is kept verbatim. An existing MX set is replaced (its old targets go in the audit entry).
3. **Apply (controller).** The controller runs a one-shot `Job` from the pinned image with the provider's credentials and arguments, `--registry=noop --policy=upsert-only --once`, a dedicated label filter, and a temporary `DNSEndpoint` holding the desired records **plus the ownership TXT records the TXT registry would have written**: name `rmx-<lowercase type>.<name>`, value `"heritage=external-dns,external-dns/owner=rapidmx-<installationId>,external-dns/resource=crd/<namespace>/<regular DNSEndpoint name>"`. With the noop registry, external-dns treats every record as its own and upserts them.
4. The Job and the temporary endpoint are deleted. The regular instance now sees the records as owned.

**Proving it early.** This mechanism is inferred from v0.23.0's source, not documented, so it is the **first thing proven on powerlevel.gg** (Phase server-3, before the rest of the server work). If it does not work on Cloudflare, the fallback is a per-provider "delete the conflicting records" call in the controller (Cloudflare first), after which the regular instance creates them. The ownership-record format is re-checked against `registry/txt` and `registry/mapper` whenever the pin moves.

### 9.4 Uninstall

`single_node_install.sh --uninstall` removes only RapidMX's values:

1. For each name in a shared TXT set (the apex), the controller runs the same noop Job that re-publishes the set with only the preserved foreign values. A name with nothing left is deleted.
2. Every `DNSEndpoint` of the release is deleted; the installer waits (bounded) until each external-dns instance has synced, checking the live DNS for the hosts' records.
3. The release is removed.

`--keep-dns` skips all of this.

## 10. Integrations API (restapi, mounted by the server)

All routes: `@RequiresTrustedRole()` plus `assertAdminScope()` (elevation) for every write; reads are trusted role. Every write is audited (4.7) with keys, never secret values.

### 10.1 `system/dns-providers`

| Route | Behaviour |
| --- | --- |
| `GET /` | List, secrets masked, with `status`. |
| `GET /types` | The provider types, their option schemas, secret fields and `tested` flag (drives the console form). |
| `POST /` | Create. Body: `name`, `type`, `zones`, `options`, `credentials` (write-only), `allowTakeover`. Validates the type schema; zones must be valid host names; credentials written to the `SecretStore` before the row; 400 when no secret store. |
| `PUT /:id` | Update; `credentials` keys omitted or given as the mask are unchanged, `null` clears. `type` cannot change. Narrowing `zones` is refused while an assigned domain falls outside them. |
| `POST /:id/test` | Queues a test operation: the controller runs a short `--dry-run --once` Job and reports whether it authenticated and found the zones. |
| `POST /:id/takeover` | Body: `domainUid`, optional record list; queues 9.3. |
| `DELETE /:id` | 409 while any domain is assigned; then 7.5 deletion. |

### 10.2 `system/integrations`

`GET` returns each section's effective values, `defaults` (from config on every request, as in 2.4), `source` per field (`"admin"` or `"deployment"`), and secrets as masks. `PUT /:section` updates one section; `POST /:section/reset` (body: optional keys, all when omitted) deletes the admin values so the deployment default applies.

| Section | Fields and validation | Config key(s) it overrides | Today |
| --- | --- | --- | --- |
| `giphy` | `enabled`, `apiKey` (secret) | `giphy:api_key` | config only |
| `stun` | `urls`: 0 to 10 `stun:`/`stuns:` URIs with host and optional port | new `integrations:stun:urls` | hard-coded in the meet plugin |
| `signingCa` | `backend` (`rfc8823`/`manual`/`none`), `directoryUrl` (https only), `contactEmail` | `mail:pki:signing_enrollment:backend`, `mail:pki:rfc8823:directory_url`, `mail:pki:rfc8823:contact_email` | config only |
| `dnsResolver` | `mode` (`node`/`doh-dnssec`), `dohEndpoint` (https only) | `mail:dns:resolver`, `mail:dns:doh:endpoint` | config only |
| `pluginRegistry` | `url` (https only), `token` (secret), `namespaces` (validated with `normalizePluginNamespaces()`) | `system:plugins:registry`, `system:plugins:registry_token`, `system:plugins:namespaces` | config only |

TURN stays in the Meet plugin's settings. Deployment infrastructure (blob/S3, mail transport and SES, ingest secret, OpenBao PKI, rspamd/ClamAV, auth-server, telemetry, Let's Encrypt, OpenSearch) stays Helm/config only.

Changing `dnsResolver` changes how every DNS check, verification and key discovery resolves; `signingCa` affects new enrollments only; `pluginRegistry` affects the next plugin install or update only. The console states these consequences next to each section.

### 10.3 Validation of URLs

Every URL field is parsed, must be `https:` (except STUN URIs), must have a host, and the host must not resolve to a private, loopback or link-local address at save time.

### 10.4 Assigning a domain

`PUT mail/domains/:id/dns-provider` with `{ dnsProviderUid: string | null }`: trusted role and elevation, checks the provider's zones cover the domain, audits `DOMAIN_DNS_PROVIDER_ASSIGN`, bumps the desired-state version.

## 11. Live Application

Today nothing is live (2.6). Reusing the plugin rolling restart (adding the `IntegrationSettings` version to the state hash) would restart every replica for a Giphy key change, so it is only a fallback for a consumer that cannot be made live in the first release.

### 11.1 The integrations config layer and `HostConfig`

- The server adds an nconf layer `integrations` directly below `plugins`; `integrations` is added to `CORE_CONFIG_NAMESPACES`, so a plugin can never declare or save these keys. On start and on every change notice the server rebuilds the layer from the `IntegrationSettings` row, resolving secret references.
- restapi gains a static, read-only accessor `HostConfig.get(key)`, which the server installs at startup over its live nconf instance (`HostConfig.install(config)`). Before installation it returns `undefined`. It is how code that was built with `@Config` (a startup snapshot) reads a value at use time, plugins included, without reaching into `ObjectFactory`'s protected `config`.

### 11.2 Propagation

A write publishes `rapidmx:integrations:changed` (row version) on Redis; every replica rebuilds the layer and notifies the consumers below. A replica that misses a message catches up within a minute (it compares the row version on a timer).

### 11.3 Consumers

| Setting | Consumer | Change |
| --- | --- | --- |
| Giphy | `server/src/routes/BaseGiphySearchRoute.ts` (`@Config("giphy:api_key")`) | Read through `HostConfig` per request. |
| STUN | meet plugin `src/util/IceServerUtils.ts` (`DEFAULT_STUN_SERVERS` hard-coded) | Reads `integrations:stun:urls` through `HostConfig` per ICE-server request; empty or `undefined` (an older server) falls back to its built-in list. Plugins may read core keys (2.5), so this needs no new plugin API, only a meet-plugin release built against the restapi version that exports `HostConfig`. |
| Signing CA | `registerCoreProviders` / `configDrivenBackend` | A delegating `SigningCertificateEnrollment` resolves the backend from config at each enrollment start; in-flight enrollments keep theirs. |
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
- `--keep-dns` for `--uninstall` (9.4).

### 12.2 OpenBao

`prepareOpenbao` additionally: enables the `kubernetes` auth method (pointing at the in-cluster API, using OpenBao's own ServiceAccount for token review, which the OpenBao chart already grants); creates the roles and policies of 5.2; issues the listener certificate and switches the listener to TLS (5.2), restarting and unsealing through the existing `openbao-unsealer`; copies the CA into the release namespace; migrates the ESO and PKI tokens and revokes them. On an upgrade of an existing installation it does the same idempotently.

Renewal: cert-manager renews the leaf certificate (1 year, renewed 30 days before expiry). OpenBao re-reads its listener certificate on `SIGHUP`. The proposal is a small sidecar in the OpenBao pod (shared process namespace) that sends `SIGHUP` when the mounted certificate changes; the fallback is a restart with automatic unseal by the existing `openbao-unsealer` (*Open Questions*).

### 12.3 Final message

With a provider: the records being published, the hosts and records that stay manual (and why), and how to watch progress. Without: the records to add per host and per domain.

### 12.4 Uninstall

As in 9.4, then the existing uninstall steps; the CRD is removed only when the installer installed it and no other release uses it.

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
    /** The DnsProvider to assign: its `uid`, or "bootstrap" for the installer's provider config. */
    dnsProvider?: string;
    dmarcPolicy?: "none" | "quarantine" | "reject";
    dmarcReportEmail?: string;
    /** Another seeded or existing domain this one aliases. */
    aliasOf?: string;
}
```

- A comma-separated string is accepted too (as `normalizePluginNamespaces()` accepts one), so `mail__domains=a.com,b.com` works.
- The chart renders the values list `mail.domains` into the service ConfigMap as JSON (`mail__domains: {{ $list | toJson | quote }}`), the same way `cors__origins` is passed. When the list is empty it defaults to `global.domain` plus each name in `postfixBridge.domains` (de-duplicated), each with `dnsProvider: "bootstrap"` when publishing is enabled. The installer's `--mail-domains` feeds it with no new flag.
- `mail:domains` is already on both protected lists. The stale doc comments (2.8) are corrected, and the `yarn dev` helper's `["example.com"]` now seeds a real `example.com` domain, which is what local development wants.

### 13.2 Validation

Each entry is validated on its own with the same rules as `BaseDomainRoute.create()`. An invalid entry is **logged as a warning and skipped**; an unknown provider, or one whose zones do not cover the name, is logged and the domain is created without a provider. Nothing here stops the server. Duplicates: the first entry wins.

### 13.3 Behaviour

At startup, after migrations, `DomainSeeder` (restapi `src/util/DomainSeedUtils.ts`, run by the server):

- **Creates a domain only when it is absent and was never seeded before.** The names seeded so far are recorded in `SetupState.seededDomains: string[]`, append-only. A name on that list is never created again, so a domain the admin deleted stays deleted even when the config still lists it, and even after a `purge` delete.
- **Never overwrites an existing domain**: the admin's edits win. An existing hand-made domain is recorded as seeded without change.
- **A name removed from the list is not deleted.**
- Creates through the same code path as `create()` (verification token, DKIM key, audit entry `DOMAIN_CREATE` with `details.origin: "seed"` and no user), with `origin: "seed"`, and assigns the provider directly.
- **Multi-replica safety**: the create is keyed by `uid` = name, so a concurrent create by another replica fails with a collision, treated as "already there"; the `seededDomains` append uses the setup row's optimistic version with `BaseSetupRoute`'s retry. No lock is needed.

### 13.4 Verification

With a provider, the ownership TXT is published with the other records, so `DomainVerificationJob` verifies the domain within minutes. Without one, it stays unverified until the admin publishes the TXT record. A reserved-TLD domain starts verified, as today.

### 13.5 Setup wizard

- `BaseSetupRoute.toStatus()`: "no domains" becomes "no domains other than seeded ones" (`origin !== "seed"`), so a fresh install with seeded domains still gets the wizard, and an existing deployment is never pulled into it.
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

- **Kubernetes rights are isolated.** The internet-facing server keeps read-only Kubernetes access. The controller holds the write rights, but has no database or Redis access, accepts only the server's authenticated calls, runs only the pinned external-dns image, and has a NetworkPolicy admitting only the server.
- **Credential exposure.** DNS credentials can redirect a domain's mail and obtain certificates for it. They live only in the secret store, are never readable back by the server (OpenBao policy without `read`), are absent from logs, audit entries, Diagnostics and Deployment specs, and reach only their own external-dns pod. With the Kubernetes-Secret backend they cross the cluster network once, from server to controller, as the existing internal mail traffic does. Recommend scoped tokens; for Cloudflare: Zone:Zone:Read and Zone:DNS:Edit on the one zone, with its zone id in the config.
- **OpenBao** is reached over TLS with a pinned CA, and every client logs in with a short-lived, audience-bound ServiceAccount token to a policy scoped to its own paths. No long-lived tokens remain.
- **Who can publish.** Creating providers, changing credentials, assigning a domain, taking over records, rotating DKIM and changing integrations all need a trusted role and an elevated token, and are audited. Adding a domain (trusted role, as today) can now create public DNS records automatically, but only inside zones an elevated admin attached to a provider config.
- **Zone confinement.** A provider config can only touch its zones: `--domain-filter`, the zone check on assignment and seeding, and the credentials' own scope. The TXT registry and the per-deployment owner id keep each deployment to its own records in a shared zone.
- **Ownership verification.** When RapidMX publishes its own verification TXT, verification proves that this deployment holds credentials able to edit the zone, which is at least as strong as pasting the record by hand. It no longer proves that a separate human acted; that is acceptable because attaching the provider already required an elevated admin. Verification is still only by public DNS lookup.
- **Takeover** can overwrite records other systems depend on: opt-in per provider, per-domain confirmation, preserved foreign TXT values, and the old values in the audit entry.
- **DKIM rotation** never switches signing to a key whose record is not live, so a rotation cannot break DKIM; a compromised key is retired as soon as signing has switched.
- **SSRF.** URL fields are validated as in 10.3.

## 16. Failure Modes

| Failure | Behaviour |
| --- | --- |
| CRD not installed | Publishing reported unavailable; domains behave as manual. |
| Controller down | Desired state keeps accumulating; nothing is published or removed until it is back; the console shows the controller as down. |
| Controller cannot verify the server's token (JWKS unreachable) | It refuses the call; the console shows the error; the Kubernetes-Secret backend cannot save credentials meanwhile. |
| Bad credentials / provider API down | external-dns retries; the provider shows Error with the last error; records keep their last state. |
| Record conflict | `conflict` with the existing value; nothing overwritten unless takeover. |
| Provider cannot hold a kind | That record is manual with its reason; the others publish. |
| OpenBao sealed or unreachable | Credential writes fail with 503; running external-dns pods keep their Secret; server-side secrets keep their cached value and warn. |
| New DKIM record never goes live | Rotation stays `pending`, signing unchanged; the console reminds the admin. |
| postfix-bridge does not acknowledge a switch | Both selectors stay published; no overlap clock; `lastError` shown. |
| Two deployments share a zone | Separate owner ids; a name both want is a conflict for the second. |
| An external-dns Deployment removed by hand | The next reconcile re-creates it. |
| Public addresses empty or private | Hosts not published; the console says why. |

## 17. Testing

- **restapi unit + real DB (Mongo and SQL)**: `DnsProvider` CRUD and validation per type; masks and write-only behaviour; elevation and audit on every write; `buildDesiredDnsRecords()` equals `checkDnsSetup()`'s recommendations for every combination (DKIM missing, rotation phases, autodiscover on/off, alias, rfc2136 kinds); apex TXT merge with preserved values; `IntegrationSettings` seed/defaults/reset; assignment rules; the desired-state route (version, long poll, no secret values) and status route (subject check); `DkimRotationJob` through every phase, including the manual-domain wait, cancel, compromised, a missing acknowledgement and two replicas racing; `DomainSeeder` (create once, never after delete or purge, never overwrite, skip invalid entries, comma-separated input, concurrent seeding); `toStatus()` with seeded domains; plugin secret migration.
- **server unit**: controller manifests golden-tested per provider (no credential in any manifest or log, image pin enforced); lease handling; token verification both ways against a fake JWKS; the Kubernetes-Secret and OpenBao backends against a fake API server and fake OpenBao (Kubernetes login, a write without read on DNS paths); `FsDkimKeyProvider` per-selector files, `activate()` atomicity and `signingSelector()`; each live consumer changes without restart; metric parsing against a recorded v0.23.0 `/metrics` page.
- **postfix-bridge**: `dkim-sync.sh` tests (per-domain selector, fallback to the global one, acknowledgement written only after a reload).
- **chart**: `helm template` tests that the server's Role has no write verbs, the controller Role is namespaced, `mail__domains` and `mail__dns__publish__*` render, and the openpgpkey two-step defaults.
- **CI**: a kind cluster job with the CRD, the chart, the controller and external-dns pointed at an in-cluster bind9 (`rfc2136` with TSIG and AXFR): create, update, DKIM rotation end to end (with a test hook shortening the grace and overlap), delete, reassignment, conflict, takeover with preserved TXT values, uninstall cleanup. rfc2136 cannot manage MX or SRV, so CI covers A/AAAA/CNAME/TXT and the manual state; MX and SRV are covered by the Cloudflare e2e.
- **Other providers** (route53, google, azure): unit tests only, against recorded API fixtures; marked "not yet live-tested".
- **e2e on powerlevel.gg** with Cloudflare, local helm package first, release only after it passes:
  1. **First, prove takeover** (9.3) on the existing hand-made records, before the rest of the server work.
  2. Install with `--dns-provider cloudflare --dns-takeover`, credentials from a file on the host only.
  3. Verify takeover (MX, apex TXT with SPF and other values preserved, `_dmarc`, hosts), automatic verification of the seeded domain, and the openpgpkey host on and certified.
  4. Rotate DKIM ("Rotate now" with a shortened grace and overlap), check that mail sent before, during and after the switch verifies at an external receiver.
  5. Add and delete a second domain; change DMARC; reassign to manual.
  6. Check the controller and external-dns logs and metrics after deploy.
  7. Uninstall with and without `--keep-dns`, checking that only RapidMX's values were removed.
  The token is never committed or stored anywhere but the test host's OpenBao/Secret, and JP rotates it afterwards.

## 18. Implementation Plan

Process per the 2026-10-27 rules: reproduce or test first, an independent review of each diff before commit, CI green before release. Order: spec, restapi, server (the takeover proof first), postfix-bridge, web-client, meet-plugin, powerlevel.gg e2e, release (restapi minor, web-client minor, server beta; postfix-bridge and meet-plugin at the level their changes need).

**restapi**
1. `SecretStore` interface + `NullSecretStore`; `SecretRef`; masks shared with plugin settings; `HostConfig`.
2. `DnsProvider` model, types registry, `BaseDnsProviderRoute`; `Domain` fields and `PUT /:id/dns-provider`; `DeploymentIdentity`; audit actions.
3. `buildDesiredDnsRecords()` and the `checkDnsSetup()` refactor (with `dkim_next`/`dkim_previous`, manual reasons); `DnsPublisher` + `NullDnsPublisher`; `BaseDnsDesiredStateRoute` (desired state, status, operations).
4. DKIM rotation: `DkimKeyProvider` additions, `Domain.dkimRotation`/`dkimManaged`, `DkimRotationJob`, rotate/cancel/pause routes.
5. `IntegrationSettings` model and `BaseIntegrationsRoute`; `integrations` in `CORE_CONFIG_NAMESPACES`.
6. `DomainSeeder` over `mail:domains`, `SetupState.seededDomains`, `Domain.origin`, `toStatus()` change; stale `mail:domains` comments corrected.
7. Plugin-setting secret references and the migration helper.

**server**
1. Takeover proof on powerlevel.gg: a hand-run noop Job from v0.23.0 against the existing records, before the controller is built. Decide noop takeover or per-provider delete from the result.
2. OpenBao: Kubernetes-auth clients for the secret store and the PKI CA, CA-bundle support; installer `prepareOpenbao` changes (auth method, roles, TLS listener, CA copy, token migration and revocation).
3. DNS controller: entrypoint, `KubeClient` write verbs, lease, token verification, desired-state long poll, manifests, external-dns Deployments, `DNSEndpoint`s, Kubernetes-Secret writes, `ExternalSecret`s, takeover and test Jobs, metrics scraping, status reports.
4. Server side: `DnsPublisher` (version counter), token verification for `/internal/dns`, `SecretStore` backends, hidden settings.
5. `FsDkimKeyProvider` rotation methods.
6. Integrations config layer, `HostConfig.install()`, propagation, and the live consumers.
7. Run the seeder at startup; bootstrap provider from `mail:dns:bootstrap_provider`; `yarn dev` seeding.
8. Chart: values, controller Deployment/Service/NetworkPolicy/ServiceAccount/Role, external-dns ServiceAccount/Role, `mail__domains`, hosts/addresses config, OpenBao CA mount, openpgpkey defaults.
9. Installer: `--dns-provider`, credentials, `--dns-zone`, `--dns-takeover`, `--public-address` and detection, CRD install, two-step openpgpkey, uninstall (9.4) and `--keep-dns`, final message.
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

1. **OpenBao certificate reload** (12.2): a `SIGHUP` sidecar in the OpenBao pod, or accept a yearly restart with automatic unseal?
2. **JWKS access on k3s.** The design relies on Kubernetes's default `system:service-account-issuer-discovery` binding letting every ServiceAccount read `/openid/v1/jwks`. Confirm on powerlevel.gg's k3s early in server Phase 3; if it is missing, the fallback is a chart-generated shared secret between server and controller (a long-lived secret, so JP's call).
3. **Route 53 TXT quoting**: settled only when Route 53 is live-tested; until then the type carries the "not yet live-tested" badge.

## Resolved Decisions

From JP, 2026-10-27:

- external-dns, not OctoDNS: a Kubernetes controller with about 40 providers, touching only records it owns, reading `DNSEndpoint`s from one namespace; its CRD is an installer-level install like cert-manager's. Pinned at v0.23.0.
- Records: exactly what `checkDnsSetup()` recommends, plus the deployment's hosts (A/AAAA for the mail host to the public addresses; CNAMEs for auth, autodiscover, openpgpkey).
- Domain add/remove and DKIM changes publish automatically.
- Per-domain provider ("manual" allowed), configured in the console; one external-dns Deployment per provider config, with a pinned image, a credentials Secret and a label filter.
- **Kubernetes writes go through a separate DNS controller pod** with its own ServiceAccount and namespace Role; the server keeps only its read-only access and records desired state (§7). The controller reuses the server image with a separate command, reads desired state through an internal API authenticated with projected ServiceAccount tokens, runs as one replica with a lease, and reports status back through the same API.
- **OpenBao**: Kubernetes auth for every client, narrowly scoped policies, TLS on the in-cluster listener with an installer-issued certificate, no new long-lived tokens (and the existing ones migrated).
- **openpgpkey certificate**: two-step HTTP-01 install.
- **DKIM rotation is built now** (6.2): scheduled and on demand, new selector published and observed live before signing switches, old selector kept for the overlap, then retired; manual domains wait for the admin.
- Takeover: proven early on powerlevel.gg with the noop-registry Job; fallback per-provider delete in the controller.
- rfc2136 stays, with MX/SRV shown as manual. Cloudflare is the e2e-tested provider; the others are unit-tested and marked not yet live-tested. DigitalOcean and webhook providers come later.
- The installer detects public addresses, with `--public-address` to override.
- Hosts outside every provider's zones stay manual and are marked so.
- Uninstall removes only RapidMX's values from shared TXT sets.
- Health comes from external-dns's metrics endpoint.
- Integrations: DNS providers, Giphy, STUN, signing CA, DNS resolver, plugin registry; TURN stays in Meet; infrastructure stays Helm/config. Typed, trusted role and elevation, audited, live-applied, reset to deployment default.
- STUN reaches the meet plugin as `integrations:stun:urls` through restapi's `HostConfig` (plugins may already read core keys; `@Config` is only a startup snapshot).
- Secrets outside the DB (OpenBao, else Kubernetes Secrets), write-only, hidden from Diagnostics; plugin-setting secrets move there too.
- The chart seeds the install's domains through `mail:domains` (unused at runtime until now): any number of entries, each with its own options; bad entries logged and skipped; never re-created after deletion; never deleted when removed from the list.
- Takeover of the existing powerlevel.gg records is approved for the e2e test.

## Status

Design. No code yet.
