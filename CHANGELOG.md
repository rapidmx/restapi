# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.36.0] - 2026-10-29

### Added
- Added the design spec for DNS publishing through external-dns, admin-console Integrations and seeding the install's domains
- Added scheduled and on-demand DKIM rotation across restapi, the server's key provider and postfix-bridge's OpenDKIM sync
- Added the SecretStore interface (DI token "SecretStore") for credentials kept outside the database, with SecretRef and SecretBackend in models/types.ts
- Added NullSecretStore, the default store, which refuses to save credentials with a 400, reports reads as unavailable with a 503 and lets deletes succeed so a row holding a reference can still be removed
- Added secretMask(), isSecretMask() and maskSecretRef(), the one write-only mask shared by plugin secret settings and the secret store
- Added toSecretPatch(), which turns a write-only form's credentials into a store patch, trimming pasted whitespace, refusing empty values and control characters, and never repeating a sent key or value in its errors
- Added HostConfig, a read-only accessor for the host server's live configuration that is installed once, uninstalled only through the handle install() returns, and returns objects as copies
- Added the DnsProvider model (Mongo and SQL, deny-all ACL) with its types, a lowercased nameKey under a unique index so two racing writes can't save the same name, and DnsProviderStatus
- Added the DNS provider types registry for cloudflare, route53, rfc2136, google and azure: options with defaults, credential fields checked for shape without repeating values, record kinds a type can't manage, zone normalization, isNameInZones and newDnsProviderUid
- Added BaseDnsProviderRoute (system/dns-providers): types, list and get for a trusted role with credentials only as masks plus domainCount; create, update and delete for a trusted role with elevation, audited without values
- Added Domain.dnsProviderUid and Domain.dnsPublication as server-managed fields, dropped by a plain PUT, refused by PUT /:id/:property and stripped on create
- Added PUT mail/domains/:id/dns-provider for a trusted role with elevation, checking the provider exists and covers the domain, audited with from and to, answering 503 when the server hasn't registered the DnsProvider model instead of failing to boot
- Added the DeploymentIdentity model and findOrCreateDeploymentIdentity(), a race-safe singleton with a random installation id that refuses a malformed one
- Added the DNS provider, domain assignment, takeover, DKIM rotation, integration and plugin secret migration audit actions
- Added buildDesiredDnsRecords(), the one source of the DNS checklist and the records the DNS controller publishes, and rebuild checkDnsSetup() on it with dkim_next/dkim_previous during a rotation, dnsManualReason() and publication states (published only once the live values are exactly the desired ones and external-dns observed the endpoint, pending, conflict by the rmx-<kind>.<name> owner record, manual with its reason)
- Added DnsPublisher with NullDnsPublisher as the fallback, and announce every domain, provider and operation change that moves the desired state
- Added the DnsControllerTokenVerifier interface and BaseDnsDesiredStateRoute (/internal/dns): the handshake, the /v1/desired-state long poll that answers at once when the server's version is behind since, and /v1/status, where only the Lease holder's report changes rows and another pod's is kept as lastStandbyReport; only the configured controller subject is accepted
- Added the v1 DNS API types mirroring dns-controller's, with the contract fixtures byte-identical to the controller's, now with zoneIds as a list
- Added the DnsOperation and DnsControllerState models (Mongo and SQL, deny-all ACL)
- Added POST system/dns-providers/:id/test, POST /:id/takeover (refusing, by name, a record type the config doesn't publish), GET /:id/operations and GET /controller
- Added Domain.apexTxt and GET/PUT mail/domains/:id/apex-txt: the opt-in owns the apex TXT set with the chosen SPF and the values to keep, refuses with 503 when the apex lookup can't be answered, keeps an existing SPF only when it authorizes the domain's own MX hosts, and queues a takeover audited with the old values
- Added Domain.dkimRotation's type and column for the next and previous DKIM records
- Added isDnsNoRecordsError() to tell NXDOMAIN and NODATA from a failed lookup, shared with federation policy lookups
- Added the optional DkimKeyProvider rotation members supportsRotation, generateKeyPair(), findKeyPair(), activate(), signingSelector() and deleteKeyPair(), counting a provider as rotating only with all of supportsRotation, generateKeyPair(), activate() and signingSelector(), and set supportsRotation false on NullDkimKeyProvider
- Added Domain.dkimManaged (Mongo and SQL), true for a key the provider made and false for one imported by hand, server-managed, classifying rows from before it once through findKeyPair(), and refuse a PUT changing the DKIM key during a rotation
- Added DkimRotationJob (Mongo and SQL) driving each domain from idle through pending, switching and overlap back to idle with one versioned row update per step, never rotating imported keys, a provider that doesn't rotate or SES
- Added GET /:id/dkim/rotation, POST /:id/dkim/rotate with compromised, POST /:id/dkim/rotation/cancel and PUT /:id/dkim/rotation with paused on mail/domains, for a trusted role with the writes elevated and audited, adding DKIM_ROTATION_PAUSED
- Added the IntegrationSettings model (Mongo and SQL, one JSON column per section on SQL, deny-all ACL) as a singleton created empty by the first change, never seeded from config, with the plugin namespaces stored without their tokens
- Added BaseIntegrationsRoute (system/integrations): GET for a trusted role with each section's values, the deployment's defaults and the source of each field, secrets only as masks; PUT /:section and POST /:section/reset for a trusted role with elevation, an optional version refused with INVALID_OBJECT_VERSION when stale, audited as INTEGRATION_UPDATE and INTEGRATION_RESET with field names only
- Added IntegrationSettingsUtils: the one table of the config keys each field overrides, the STUN, https URL, contact and namespace validators, the deployment defaults without URL credentials, the view and buildIntegrationsConfigLayer() for the server's integrations layer
- Added the giphy:enabled config key, emptying giphy:api_key in the layer when Giphy is off
- Added integrations to CORE_CONFIG_NAMESPACES
- Added DomainSeeder (Mongo and SQL) creating the domains listed in mail:domains at startup through the console's own create path, with origin "seed", audited as DOMAIN_CREATE without a user and announced to the DnsPublisher, never creating a name recorded in SetupState.seededDomains again and never changing or deleting an existing domain
- Added parseSeedDomainEntries() reading mail:domains as a list, JSON text, one object or a comma-separated string of names, skipping a malformed, repeated or misspelled entry with a warning so a corrected entry seeds on a later start
- Added SetupState.seededDomains and Domain.origin ("seed" or "console", server-managed, set by create and refused from clients) on both backends
- Added updateSetupState(), retrying a setup row save that lost an optimistic-lock race on the re-read row, used by the seeder and by the setup route's step save, complete and reopen
- Added PluginSecretUtils: pluginSecretPath() giving plugins/<package>/<key>-<16 hex>, a new path per write capped at 253 characters with a hashed cut for long names, writePluginSecretSetting(), storePluginSecretSettings() for every save path and the server's seeding, resolvePluginSecretSettings() for the plugin host, plaintextSecretKeys()/plaintextPluginSecrets(), releasedPluginSecretRefs() and withoutSecretSettings()
- Added PluginSecretMigrator (Mongo and SQL) moving plaintext secret settings into the store at startup page by page with one versioned update per row, retrying a lost race on the re-read row, dropping an uninstalled plugin's plaintext secrets, auditing PLUGIN_SECRET_MIGRATED per key without values, and reporting what remains in plaintext without a store
- Added the open questions the approved plan leaves for JP: keyring reload, activation delay, the keyring Secret and lookup, the rotator's image, key removal timing, the rotator's API, console run-now, the plugin-state hash, rolling upgrades, v1 in place, the controller's internal API, installer bootstrap credentials, credentials over in-cluster HTTP, IntegrationSettings field names and the server step 2 trim
- Added ConfigCipher, encrypting configuration secrets as AES-256-GCM envelopes bound to their record, row and field by length-prefixed associated data, with the active key taken from ConfigKeyState.activeKid when it is in the ring and otherwise the oldest key, so a key a first rotation adds never encrypts before it is activated
- Added the keyring loading from config_encryption:keyring_file or config_encryption:keyring, re-read every minute, on the rotation notice and on an unknown kid at most once a minute, keeping the loaded keyring and logging once when a reload fails, with the production guard and the development keyring helper
- Added ConfigSecretUnavailableError naming the record and field and never a value, and decryptString() refusing a stored number or flag
- Added the ConfigKeyState model for Mongo and SQL, ConfigCipherMongo and ConfigCipherSQL, and config_encryption among the core configuration namespaces
- Added the rule that the more specific agent model assignment wins where categories overlap
- Added the ConfigKeyringStore interface with FileConfigKeyringStore, whose write replaces the keyring only when its version is still the stored one, and resolveConfigKeyringStore() choosing the store by config_encryption:keyring_store:backend Add ConfigKeyChannel with RedisConfigKeyChannel for the server to register and the in-process LocalConfigKeyChannel only outside production, so production without a registered channel has no rotation rather than copies coordinating alone Add ConfigKeyHeartbeat reporting the loaded keys and the encrypting key every 30 seconds with a 90 second TTL, after each keyring reload and on rapidmx:config-keys:changed Add the ConfigEnvelopeSource registry through which the rotation re-encrypts each record type's envelopes Add ConfigKeyRotationJob for Mongo and SQL, adding, activating, re-encrypting and retiring keys under a Redis lock every 30 seconds and on rapidmx:config-keys:changed, with every write version-checked, paging each pass by uid after the last row so a row deleted or added meanwhile is never skipped, and naming the rows it can't save or the error that stopped a pass in the rotation's lastError Add BaseConfigKeyRoute with GET /, POST /rotate and POST /activate for Activate anyway, one rotation at a time (409, a compromised request upgrading a running normal one), and 503 when the keyring store is none, can't be read or has no Redis channel in production Add the CONFIG_KEY_ROTATION_REQUESTED, CONFIG_KEY_ROTATED, CONFIG_KEY_ACTIVATED, CONFIG_KEY_ACTIVATION_FORCED, CONFIG_KEY_RETIRED and CONFIG_REENCRYPTED audit actions and the unreadable and complete fields of ConfigKeyState.reencryption Add ConfigCipher.loadedKids(), keyInfo() and onChange()
- Added GET /internal/dns/v1/providers/:uid/credentials for the DNS controller's token, answering with decrypted values and naming unreadable fields, uncached and never logging a value
- Added DnsProviderEnvelopeSource so key rotation re-encrypts DnsProvider credentials without bumping credentialsGeneration
- Added integrationSettingsEnvelopeSource() so key rotation re-encrypts the Integrations secrets, registered in ConfigKeyRotationJobMongo and ConfigKeyRotationJobSQL
- Added pluginEnvelopeSource() so key rotation re-encrypts plugin secret settings, registered in ConfigKeyRotationJobMongo and ConfigKeyRotationJobSQL
- Added the DNS API contract fixtures to .gitattributes as LF text so their bytes match dns-controller's whatever core.autocrlf says
- Added SetupState.bootstrapDnsProviderUid, the uid of the DNS provider config the server created for the installer, set once so that deleting that config in the console is final
- Added automatic takeover of the records in conflict for a provider config with allowTakeover, planned by planAutomaticTakeovers() when the Lease holder's status report is applied, for domains and the deployment's hosts, once per name, type and values, audited as the system
- Added the takeover of the deployment's hosts with POST system/dns-providers/:id/takeover {hosts: true} on the hosts-<uid> endpoint set, and GET system/dns-providers/hosts with each host's publication
- Added the type_mismatch conflict reason with the existing records to delete, for a CNAME wanted next to other records or the reverse, for domains and hosts, never deleted and never taken over by the server or by a manual takeover, ignoring what a wildcard record of the zone answers
- Added DnsResolver.resolveAddresses() as an optional lookup, implemented in NodeDnsResolver
- Added the server's As implemented note for web-client W6 to the DNS publishing spec

### Changed
- Publish only from a release tag's own Build, and only once every Build of that commit has finished green
- Move all Kubernetes writes in the DNS publishing spec to a separate single-replica DNS controller that reads desired state from the server's internal API, leaving the server read-only
- Specify OpenBao Kubernetes auth with per-consumer scoped policies and TLS on the in-cluster listener, migrating the existing periodic tokens
- Seed the install's domains through mail:domains and read STUN servers in the meet plugin through a new HostConfig accessor
- Settle the remaining open questions with JP's defaults and update the phased plan
- Make the DNS controller a dedicated project, rapidmx/dns-controller, with its own minimal distroless image that the server chart templates and pins in lock-step, instead of the server image with another command
- Version the controller's internal API under /internal/dns/v1 with an apiVersion in every payload and an unversioned startup handshake after which a mismatched controller refuses to act and the server records the mismatch for the console
- Fetch the service-account JWKS in-cluster from kubernetes.default.svc, confirmed readable through the issuer-discovery binding on k3s v1.36.4
- Reload the OpenBao listener certificate with a SIGHUP sidecar on certificate change instead of restarting
- Record the takeover spike results: noop-registry takeover proven on Cloudflare, the exact ownership TXT name and value, no TTL on ownership records, quoted TXT targets, and whole-set ownership after a takeover
- Move ownership verification to _rapidmx-verify.<domain>, accepting the legacy apex token during a transition while recommending and publishing only the new name
- Propose apex SPF management only on a per-domain opt-in with an editable list of values to keep, restored on opt-out, domain deletion and uninstall
- Use the shared secret mask helpers in BasePluginRoute in place of its private copy
- Update the DNS publishing spec for the "none" backend, NullSecretStore's per-operation failures, the mask helpers and HostConfig's one-time installation
- Write DNS provider credentials to the SecretStore at dns/<uid> before the row, removing them again when the row can't be saved, and remove them after the row on delete, auditing secretLeftBehind when they stay
- Refuse a stale version on PUT /:id with INVALID_OBJECT_VERSION, check it again right before the store write, and when the row write still fails after the store changed point the current row at the new secretRef and audit rowWriteFailed
- Never send a secretRef from another backend to the current store: clearing every credential leaves it there, replacing every credential writes a new secret, keeping some is a 409
- Count a provider's assigned domains with count() and check zone narrowing against every page of them
- Move DnsRecordType to models/types.ts, still exported from DnsSetupUtils
- Register an InMemorySecretStore as SecretStore for every test server, with a hook that stages a write racing a store call
- Update the DNS publishing spec for list-valued options, nullable secretRef and status, nameKey, per-type validation, the response shape, the PUT race and foreign-backend handling, the audit details, the test and takeover routes moving to step 3, and the server prerequisites of this release
- Verify domain ownership at _rapidmx-verify.<domain> with findDomainVerification(), still accepting the token at the apex while mail:domain_verification:accept_legacy_apex is on (the text "false" turns it off), and audit where it was found
- Build the desired state from every provider config, each domain published through a config covering it, the deployment's hosts without the records a domain's endpoint set already publishes, and the queued or running operations, never a credential
- Refuse to delete a DNS provider config while a restore of it is queued or running, and cancel its other pending operations when it is deleted
- Restore the SPF value and the kept values on an opt-out or the deletion of a managed domain, queuing the restore before the write and cancelling it if the write fails, and refuse reassigning a managed domain
- Require an elevated token to delete a domain published through a provider config
- Make the test StaticDnsResolver answer with ENOTFOUND codes and fail lookups for the names in failing
- Update the DNS publishing spec: 9.4 decided, the legacy apex key, apexTxt.spf, the operations and controller state models, restoring SPF with the kept values, the lookup-failure refusal, exact publication, host deduplication, the long poll on a reset counter, standby reports and provider deletion with a pending restore
- Give FsDkimKeyProvider one key file per selector, <domain>.selector written atomically by activate() (refusing a selector without a key), <domain>.signing read as the MTA's acknowledgement, and deleteKeyPair() refusing the selector signing uses
- Generate DKIM keys asynchronously off the event loop, with mail:dkim:rotation:key_bits accepted only as a whole number from 2048 to 4096 (or its text) and 2048 with a warning otherwise
- Start scheduled rotations only for enabled and verified domains with a key, at most mail:dkim:rotation:max_starts_per_run per run, never minting again a selector used earlier the same UTC day
- Delete a newly generated DKIM key whose recording lost a race unless the winning row names its selector, and point the provider back at the row's selector when a cancel reverted a switch the job was activating
- Treat "Key compromised" during a rotation as the replaced key's: a pending rotation skips the grace, a switching one gets no overlap and an overlap is retired at once
- Revert a switch the MTA hasn't confirmed on cancel, signing with the old key again before and after the versioned write and refusing when the old key is gone or can't be activated
- Update the DNS publishing spec for the rotation as built: FsDkimKeyProvider's methods in restapi, findKeyPair(), the extra state fields, the start limit, reverting cancel, compromise during a rotation, key size checks and the server's remaining step
- Protect the DKIM rotation job's mail:jobs:dkim_rotation namespace from plugin settings like every other core job
- Clear the domains the SQL DKIM rotation and domain verification suites leave in the shared test database, which made later SQL suites find verified domains
- Write the Giphy key, the registry token and the plugin namespaces' tokens to the SecretStore before the row, each write at a path of its own under server/, removing the secret it replaced after the row is saved and the new one when the row can't be saved, so a failed save never changes the secret in use
- Merge a write that lost a race field by field on the newer row, the last saved secret winning, and refuse with 409 a namespaces change whose tokens another write changed meanwhile
- Keep the deployment's registry token and its default-registry namespace tokens away from a registry URL the administrator points elsewhere, in the layer and in the view
- Refuse an empty STUN server list, which the meet plugin would take as its built-in list
- Tie the RFC 8823 ACME account to the CA it was registered with, registering the same key again when the directory changes, sending a changed contact email to the account and driving each enrollment at the CA and account it was started with
- Export DEFAULT_RFC8823_DIRECTORY_URL
- Update the DNS publishing spec for Integrations as built: no seeding from config, namespace tokens in their own secret, a secret path per write, the registry credential rule, the STUN list of 1 to 10, the ACME account per CA and the server's prerequisites
- Assign a seeded domain the DNS provider its entry names, "bootstrap" meaning the one installer provider, only when that provider's zones cover it, and create it manual with a warning otherwise
- Adopt mail:domains on a deployment that predates seeding, recording every listed name as seeded without creating any, so an upgrade never brings back a domain deleted before it or creates one never added
- Read SetupState.seededDomains again right before each seeded create, so a domain another replica seeded and the admin deleted meanwhile isn't created again
- Move the domain create path into prepareNewDomain() in DomainUtils, shared by BaseDomainRoute.create() and DomainSeeder, creating a domain without a DKIM key when no DkimKeyProvider is registered
- Keep setup required on a deployment whose only domains were seeded, a domain seeded between the two counts included
- Correct the stale mail:domains comments of the transport rules
- Update the DNS publishing spec for domain seeding as built: the shared create path, the accepted formats, adoption on upgrade, the re-read before each create and what server step 7 must do
- Keep a plugin's secret settings in the SecretStore while the deployment has one, the row holding only { "$secretRef": SecretRef } (PluginSettingValue, isPluginSecretRef()) with the value stored as text under value and its type for a number or a flag
- Write a secret setting's plaintext to the store before the row on every save path (PUT, a value an older row still holds, settings carried to a new version, defaults on add and revival, an uploaded pack's replacement), removing what was written when the change fails and deleting replaced, cleared, undeclared and uninstalled secrets after the row is saved
- Skip, when undoing a failed change, any secret the re-read row still names, so a row another change saved meanwhile never names a removed secret
- Check a secret reference kept across a version change against the new version's setting when its type, bounds or options changed, refusing a value it no longer takes with 400 and one that can't be read back with 503
- Keep the row's reference when the mask is sent back, refuse a reference sent as a value, and mask every reference in responses whatever the setting is called
- Keep secret settings on the row as before on a server without a secret store
- Count a reference in computePluginStateHash() by backend, path and generation, never the value, leaving plain values' hash unchanged
- Strip every secret setting from an uninstalled plugin's row
- Move isSecretSetting() to PluginUtils, still exported from BasePluginRoute
- Note the plugin-settings exception and the per-write paths in the SecretStore doc
- Update the DNS publishing spec for step 7 as built: the row's form, the path per write and its length cap, no refusal without a store, kept references checked on a version change, the rollback re-read, the migration, and what the server must do and in which release order before registering a real store, including seeding default plugins through storePluginSecretSettings()
- Record in the spec that the meet plugin reads integrations:stun:urls as integrationDefaults() reads a deployment's value and keeps only the entries normalizeStunUrls() accepts, falling back to its built-in list when none is left
- Record in the spec that the meet plugin logs ignored STUN entries once per value with counts only, and reads HostConfig and normalizeStunUrls through the module namespace so an older server falls back instead of failing the plugin's load
- Update the DNS publishing spec for dns-controller C2 as built (the C2 edits first went out in c8da9da): date C2 2026-10-27, and record that a failure applying a new desired state is logged and the poll goes on, and that the controller's ports listen on IPv6 as well as IPv4
- Correct the DnsDesiredStateApiV1 header comment: the controller's copy has StatusReportResult since its phase C2, not C3
- Update the DNS publishing spec's postfix-bridge section as built after review: the key a domain moves off stays until the server deletes it, <domain>/selector records the one in use, the acknowledgement follows one pass after the reload with its limits, and only plain files are read from the shared volume with <domain>.signing written by exclusive create and rename
- Update the DNS publishing spec for server step 2 as built: the server role's patch on the data paths and delete on the metadata paths, the roles' bindings and token lifetimes, OpenBaoClientPkiCertificateAuthority replacing restapi's fetch with a CA-verifying client, a re-login only on a 403 to a token older than a minute, the chart's removed PKI token and its openbao.auth with a Secret for a static token, the logins checked before the old tokens are revoked, the reload sidecar matching bao server by its arguments and never itself, the OpenBao CA mount arriving in step 2, and the auth-server chart's caProvider needed before the release
- Update the DNS publishing spec for dns-controller C3's first part as built: the arguments, the credentials Secret and its env and files, Azure's azure.json built by the ExternalSecret template, replicas 0 without a required credential, the ExternalSecret, rolling on the generation the Secret holds, the image pin accepting the pin's tag, applying, pruning and when it reconciles, the chart's new settings, and the Role's get on Secrets
- Record that a TXT value over 255 bytes is written as several quoted strings, and that the quoted form is for Cloudflare, Route 53 and Google only: Azure takes its one value verbatim and rfc2136 plain values unquoted
- Record that a TXT record a provider can't keep is left out and must show as manual: an Azure name with several values, and an rfc2136 value with a space, a semicolon or a quote, which external-dns v0.23.0 can never update or delete there
- Record that an instance is kept out of zones other configs nest under its own with --exclude-domains, and that a state with a provider without zones, a zone in two configs or a credentials path outside dns/ is refused whole, asking restapi to refuse a zone in two configs and to assign a domain to the most specific config
- Record that a deleted provider's Deployment is removed after its ExternalSecret and Secret, and that the Lease is released only after the request under way was answered
- Rewrite the DNS publishing spec's secrets design to JP's approved plan of 2026-10-28: the database as the single source of truth for all configuration, credentials, API keys and tokens stored as AES-256-GCM envelopes in their own fields bound to record type, uid and field, one configuration keyring delivered by External Secrets from OpenBao or from a chart-generated Secret, and production refusing to start without a key
- Specify the in-memory cache of decrypted secrets for the life of the process, dropped on the existing change notices, with no per-request database read or decryption
- Specify key rotation: the newest active key encrypts and any decrypts, a key-rotator CronJob with its own ServiceAccount limited to the keyring Secret or its OpenBao KV path, manual and compromised rotation from the console, version-checked re-encryption with usage counts, old keys removed only once unused, and keyring backups
- Specify DNS provider credentials encrypted on the DnsProvider row with credentialsGeneration, fetched by the controller from GET /internal/dns/v1/providers/:uid/credentials to write the one Secret external-dns reads, with no ExternalSecret path
- Specify plugin secret settings encrypted in the Plugin row by an idempotent startup migration replacing PluginSecretMigrator, with plugins still receiving plaintext
- List the rework of restapi ade9731, befb6b5, 9013465 and cbfe83b, the ExternalSecret parts of dns-controller 4bde52b and the trim of server 467f5f9, and what is unaffected
- Move the auth-server caProvider prerequisite from the open questions to the implementation plan
- Make the key-rotator the dedicated rapidmx/config-key-rotator project and image, minimal like dns-controller, with its own releases pinned by the server chart in lock-step, its API, rights, CronJob and contract fixtures described in 5.5
- Decide that DNS credentials travel over plain HTTP inside the cluster with no TLS on the internal API, recording JP's reasoning that observing pod-to-pod traffic already needs node-level access and with it the keyring and the database
- Decide the trim of server 467f5f9 (mail:secrets:openbao:* settings, mail:secrets in the protected keys, the integrations/* KV paths and policies, the ESO read on integrations/dns/*, the dns-controller OpenBao role) and list every removal with its repository in 18.1
- Record the three decisions of 2026-10-28 in Resolved Decisions, remove their open questions and renumber the rest with their references
- Make configuration-key rotation manual only and performed inside the server, removing the automatic schedule (rotation_days), the key-rotator CronJob, the rapidmx/config-key-rotator project and image, its Role and OpenBao policy, its /internal/config-keys/v1 API and contract fixtures, its chart values, tests and release-list entries, and the console "run now"
- Give the server get/update on exactly the keyring Secret by resourceNames without OpenBao, and read/write on only the keyring KV path with OpenBao with External Secrets syncing it every minute, keeping the server read-only on every other Kubernetes resource in 7.6 and 15
- Describe the rotation steps of ConfigKeyRotationJob (adding, activating, re-encrypting, retiring) with the old key removed as soon as no envelope uses it, for a compromised rotation immediately after re-encryption, and ConfigKeyState recording the progress for the console
- Propose activating a new key only once every running server copy reports loading it through a Redis heartbeat, with a "waiting for N copies" status and a timeout warning, replacing the fixed 10-minute activation delay
- Record the manual-rotation decision of 2026-10-28 in Resolved Decisions, remove the open questions on when an old key goes, how the rotator learns usage and the console "run now", and renumber the rest with their references
- Record the standing agent model assignments in the project notes
- Move the agent model assignments to the top of the project notes, keeping session history at the bottom
- Mark the DNS publishing spec APPROVED by JP on 2026-10-28, with implementation proceeding
- Record JP's approval of re-reading the keyring every minute, on the rotation notice and on an unknown kid, rendering the keyring Secret only when absent and keeping it, the plugin-state hash by decrypted value, v1 changed in place, installer bootstrap credentials through a server-only temporary Secret and the IntegrationSettings field renames
- Decide activation once every live server copy reports the new key through its Redis heartbeat, never on a timeout, and add the elevated, audited "Activate anyway" (POST system/config-keys/activate, CONFIG_KEY_ACTIVATION_FORCED), which leaves re-encryption waiting for the stale copies
- Replace the release-note requirement for encrypted plugin settings with an encryption run that waits until no server pod of an older ReplicaSet is left, checked through the existing read-only pods access, saving secret settings in plaintext until its first completed run (ConfigKeyState.pluginSecrets)
- Record the approved keyring_store settings, heartbeat and warning times, rotation job cadence, chart values and one rotation at a time
- Settle Route 53 TXT quoting from external-dns v0.23.0's source and record that values over 255 bytes must be pre-split, as confirmed live on Cloudflare
- Settle that an unowned record at a name blocks only creation there, so the one-shot Job is needed only for an MX's first creation at an unmanaged apex
- Make 18.2 the definitive ordered implementation plan: restapi R1a to R4, dns-controller D1 to D5, auth-server, server S1 to S11 and web-client W1 to W6
- Move the answered questions to Resolved Decisions and list the three new ones raised while finalizing
- Record JP's approval of the three questions raised while finalizing the DNS publishing spec
- Skip a periodic keyring reload while the previous one is running and discard a ConfigKeyState read that finishes after a later one started
- Replace maskSecretRef() with maskCredentials()
- Record in the DNS publishing spec that the oldest key encrypts until a key has been activated, the ConfigCipher classes and API as implemented in R1a, and the reload rules
- Update the agent model assignments to JP's revised criteria: Sonnet for general code and review, Opus for architecture, planning, investigation, security and performance, Haiku for simple operations
- Record in the DNS publishing spec the rotation as implemented in R1b, with no in-process channel in production, uid-ordered re-encryption pages, failed rows and pass errors in lastError and the keyring read that POST /rotate makes first
- Record in the DNS publishing spec R2's credentials on the row, the credentials route, the zone and most specific config rules, the TXT values a provider can't keep and the apex opt-in refusals for Azure and rfc2136
- Store DnsProvider credentials as ConfigCipher envelopes with credentialsGeneration in the row's own versioned write, replacing secretRef and the two-store race handling, and answer 503 when a credential is saved without a keyring
- Change DnsProviderV1.secretRef to credentials with keys and generation in place in the v1 types and the shared fixtures, and add the provider-credentials fixtures
- Refuse with 409 a zone another DNS provider config already has, and a zone that covers a domain assigned to another config more specifically
- Refuse assigning or seeding a domain to a config other than the one whose zones cover it most specifically
- Report kind_unsupported for an Azure TXT name with several values and an rfc2136 TXT value that isn't one plain character-string
- Refuse with 400 the apex TXT opt-in and edits when the provider can't keep the SPF value and kept values (Azure with kept values, rfc2136)
- Record R2 in the project notes
- Record in the DNS publishing spec R3's synchronous layer function returning unreadable field paths, the unguarded clear, the envelope source, why the view shows the mask for an unreadable envelope and the rotation job's retirement window as an open follow-up
- Store IntegrationSettings giphy.apiKey, pluginRegistry.token and each namespace's token as ConfigCipher envelopes, replacing apiKeyRef, tokenRef and namespaceTokensRef
- Delete the Integrations path per write, store writes, cleanup and the no-store 400, and write the section once with the secrets sealed inside it, answering 503 when a secret is saved without a cipher or keyring
- Make buildIntegrationsConfigLayer(settings, cipher, deployment) decrypt the secrets, leaving out and reporting by field path any it can't read
- Let noConfigCipher() take the name of what can't be handled
- Record R3 in the project notes
- Encrypt secret settings in the Plugin row on every save path once ConfigKeyState.pluginSecrets.encryptedAt is set, saving them in plaintext before that and answering 503 with nothing changed when there is no cipher or keyring
- Decrypt a kept value for the version-change check only when its definition's type or bounds changed, and compute computePluginStateHash() and resolvePluginSettings() from decrypted values, leaving out an envelope that can't be decrypted
- Replace PluginSecretMigrator with PluginSecretEncryptor (Mongo, SQL), waiting on the injected ServerRolloutCheck, taking the key-rotation lock, auditing PLUGIN_SECRET_MIGRATED per key and recording encryptedAt, with runUntilEncrypted() as the server's 30 s loop
- Make resolveServerRolloutCheck() default to rolled out only for a server that registers no check outside Kubernetes, and wait with UnavailableServerRolloutCheck when the registered check fails to start or a Kubernetes server registers none
- Keep an encryptedAt another server copy recorded when writing the waiting state, look at the rows once more after recording encryptedAt, and retry a run that failed on a datastore error or a key state it couldn't save
- Record R4 in the project notes
- Record in the DNS publishing spec R4's PluginSecretEncryptor, ServerRolloutCheck fallbacks, final pass after encryptedAt and the cipher parameter of computePluginStateHash()
- Record in the DNS publishing spec that server S1 removed the NullSecretStore registration because restapi R4 deleted the class, and fix the Status sentence that read as S1 adding it
- Describe the dns-controller's credentials Secret as built in D2: written when missing, behind or owned by a replaced Deployment, never deleted while the image pin keeps the Deployment from being updated, with the credentials generation, the image pin and the unreadable-field handling in 7.2 to 7.4 and 18.2
- Record in the DNS publishing spec that dns-controller D3 implemented the status report's provider, endpoint and operation entries, with the report after each pass, the completed-rollout meaning of lastRolloutAt and the restapi follow-up to store it in 7.2, 7.3, 7.4, 7.7 and 18.2
- Record in the DNS publishing spec the unreadable flag of a secret's mask that web-client W1 reads, and make it an acceptance criterion of server S2 and S6
- Record in the DNS publishing spec that dns-controller D4 implemented the operation Jobs, with the waits of a takeover and a restore, the results taken from the Job, the Job as the durable record without a TTL, and the live check of a restored set that stays the server's, in 7.2, 9.3 and 18.2
- Record in the DNS publishing spec that the server's plugin host cipher is registered under a name of its own, that default plugin secrets are seeded in plaintext while a rotation has another key active, that the unreadable marker also covers a key the process has not loaded, and that the Redis channel is registered for the shipped configurations, in 5.5 and 10.2
- Record in the spec how dns-controller D5 reads the health, what the real v0.23.0 image showed (no provider error counter, no owner-mismatch series) and what restapi must carry before D5 ships, including leaving the volatile status fields out of the provider row's change comparison
- Update the DNS publishing spec: the first dns-controller image carries D1 to D5 together, and the provider row's change comparison also leaves out providerErrors
- Record the server S3 keyring chart and installers in the DNS publishing and Integrations spec, including the hook, the render guard, the ownership check and the none backend found in review
- Update the DNS spec with the server step S4 as implemented: the publisher, the verifier's key refresh, the /internal/dns mounting and the Autodiscover announcement
- Record in the DNS publishing and Integrations spec that the server ships scheduled DKIM rotation off until S8 moves the postfix-bridge pin, which turns it on
- Record the server S6 live integrations in the DNS publishing and Integrations spec, including the plugin host installing from the deployment's registry only, the delegating signing enrollment's failure handling and the realities that differ from the consumer table
- Record the server S7 seeding and bootstrap provider in the DNS publishing and Integrations spec, including the durable created-once record, the held-back bootstrap domains and the notice for an existing config
- Record the server S9 chart for DNS in the DNS publishing and Integrations spec, including the empty controller pin until its first release, the bootstrap provider keying the seeded domains, the long poll and status settings, the server CA, the host CNAME and leaving the controller's objects to the console and the installer on turning publishing off
- Record the server S10 installer for DNS in the DNS publishing and Integrations spec, including the IPv4-only address detection, the apex TXT restore left to the console, the domains that predate publishing, the Secret read only from the server's log since it was made, the controller image left to the environment until its first release and the uninstall waiting only for the targets that were published
- Record in the spec that the server's S11 is implemented, with the one contradiction it found: a k3s cluster the installer made is removed whole on uninstall, keyring Secret included, not kept as 12.4 says
- Record in the spec the Diagnostics wire shapes web-client W6 expects for the DNS pods, the integrations layer and the keyring
- Keep a failed manual takeover from using up the automatic one, clear a provider's hosts endpoint status when its report no longer has the set, and wait for the minimum interval before the scan a report requested meanwhile
- Record the step in the spec and the project notes
- Cover every line of the takeover refusals, the hosts' observed check, the operations without an endpoint set and the unknown record type, and judge nothing for a takeover without an owner id the way the checklist does
- Answer a DKIM record lookup that fails without saying the name has no records as unknown, so one timeout or SERVFAIL no longer restarts the publish grace of a pending rotation
- Count six hours of unanswered lookups of a pending rotation's new record as the record being gone and log the first unanswered lookup of such a streak as a warning
- Record the step in the project notes and the DNS publishing spec
- Install corepack with npm before enabling it in the Build and publish workflows, since node:lts-trixie-slim no longer ships it and every job failed at corepack enable
- Accept endpointSetId up to MAX_ENDPOINT_SET_ID_LENGTH in a status report so a domain name of about 94 characters no longer makes every report a 400
- Report any TXT at _rapidmx-verify as found and only the exact token as matching so another token there is a not_owned conflict a takeover replaces
- Carry the deployment's registry URL credentials onto an administrator URL that is the same registry in buildIntegrationsConfigLayer()
- Refuse to encrypt with a 503 and report no encrypting kid until ConfigCipher has read ConfigKeyState once instead of using the oldest key
- Record the kids the keyring held in ConfigKeyRotation.keyringKids before the rotation writes its key and adopt a key not among them after a crash instead of comparing createdAt with requestedAt
- Remember per copy which endpoint sets the automatic takeover scan found clean at the generation of the report it was made for and skip them for mail:dns:takeover:recheck_seconds, reading only takeover and restore operations
- Record a look as a conflict only when a takeover could be queued from it and not at all when a lookup failed other than NXDOMAIN or NODATA so a failing resolver does not suppress a takeover for hours
- Keep a record whose value is the zone wildcard's judged not_owned since no lookup tells it from the wildcard alone and hiding it would leave it pending with no takeover
- Cancel an apex TXT restore that has not started while every value it restores is still at the apex when the set is opted in again, and answer 409 naming the restore for any other
- Save the apex TXT opt-in before queueing its takeover and put the row back when the takeover cannot be queued so a state read never lists a takeover the endpoint set does not hold
- Recount every envelope source right before the keyring write in ConfigKeyRotationJob.stepRetiring and go back to reencrypting when the old key is still in use, so an envelope saved after the last pass is no longer orphaned
- Record the round 1 fixes of dns-controller and server in specs/dns_publishing_and_integrations.md as As implemented notes and close the spec 10.2 follow-up in the project notes

### Fixed
- Fixed the stale integrationSecretPath() mention in the pluginSecretPath() comment and the SecretStore header
- Fixed the concurrent first read of a mailbox's folders returning a partial list when a loser's ACL claim was refused before the winner's folder row existed

### Removed
- Removed SecretStore, NullSecretStore and SecretRef from the design, keeping the masking helpers and HostConfig, and trim OpenBao to the release secrets, the PKI CA and the keyring
- Removed the dns-controller's own internal API from the design (its listener on port 8080, Service, server-to-controller token, DNS_CONTROLLER_SERVER_SUBJECT and the NetworkPolicy admitting the server), keeping only its health endpoints
- Removed SecretStore, NullSecretStore, SecretRef, SecretBackend, PluginSecretSettingRef and the store parts of PluginSecretUtils

## [0.35.0] - 2026-10-26

### Added
- Added EncryptionPolicy.allowOpenPgp (mail:encryption:openpgp_allowed, on by default), refusing OpenPGP enrollment and leaving OpenPGP keys out of public discovery while off
- Added BaseWkdRoute, the OpenPGP Web Key Directory serving a mailbox's newest active OpenPGP certificate over the direct and advanced methods

### Changed
- Adopt OpenPGP as a second end-to-end format for interoperability with OpenPGP users in the E2E spec, keeping S/MIME RapidMX's own and preferred format
- Store an OpenPGP certificate as one PublicKey of type openpgp and useType encrypt, checked and sanitized from the certificate itself with OpenPGP.js
- Pin, supersede, record conflicts and keep previous keys per key slot (use and format), so a contact's S/MIME and OpenPGP keys never replace each other
- Replace a pinned OpenPGP key automatically only when it is retired and certified its successor
- Enroll a mailbox's self-certified OpenPGP key through POST /:id/keyvault/keys with type openpgp, marking its wrapped secret key with type openpgp
- Trust and resolve a contact's OpenPGP key through /:id/keys/trust and /:id/keys/resolve with type openpgp
- Publish OpenPGP certificates on the RapidMX discovery endpoint, listing active keys first
- Keep the RapidMX-Key header and the receipt key announcement to S/MIME certificates
- Treat an inline OpenPGP message as encrypted on delivery
- Look up the OpenPGP key of an address whose domain isn't a RapidMX peer in its domain's Web Key Directory, with the discovery client's SSRF guards
- Announce a mailbox's OpenPGP certificate in an Autocrypt header on outgoing mail, next to RapidMX-Key
- Pin the OpenPGP key of an inbound Autocrypt header that aligned, passing DKIM oversigns
- Check the openpgpkey.<domain> CNAME in a domain's DNS setup
- Relay a message only to its envelopeRecipients when it has them, so a mixed S/MIME and OpenPGP send delivers each copy to its own recipients
- Specify v4 OpenPGP keys as the default a mailbox is given, with v6 keys still accepted everywhere, and test both versions
- Report when each week becomes compactable and the size of its pending entries in the search index manifest, so clients can stagger compaction by platform and phones can decline large weeks
- Choose an end-to-end format per recipient from the contact's own preferred format, the format the address advertises in discovery and the RapidMX-Key header's _prefer-format, or the format it was last seen using in authenticated mail, falling back to S/MIME
- Let a mailbox owner advertise a preferred format, publishing OpenPGP only while there is an active OpenPGP key
- Test oversized OpenPGP keys against the byte cap with an armored key that fits the text cap
- Drop an unnecessary type assertion in the SQL contact route test
- Specify which data types zero-access encryption covers - mail, calendar, contacts and tasks - what stays readable to the server and why, contact email addresses included, and how defaults follow the owner's ActiveSync and Outlook clients
- Let a mailbox owner choose the data types zero-access covers, deciding undecided ones from the clients that sync the mailbox when zero-access is activated, never taking protection away from mail
- Record the ActiveSync and Outlook clients that sync a mailbox and when its zero-access keys were exported, for those defaults
- Seal calendar, contact and task fields one by one to the mailbox's zero-access key on every write, ignoring a placeholder sent back unchanged
- Seal task titles and notes when zero-access covers tasks, and refuse filtering or sorting tasks by them
- Seal a contact's details when zero-access covers contacts - names, company, job title, notes, phone numbers, postal addresses, categories and email labels - keeping every email address readable and showing the first in place of the name
- Store a protected contact's photo sealed and serve it as opaque bytes for the client to open
- Share the zero-access sealing of REST writes between the task and contact routes
- Seal calendar event titles, locations and descriptions when zero-access encryption protects the calendar
- Send a protected event's invitations at save time from the request's invitationContent, never from the stored placeholders
- Extract MeetingInviteSender from MeetingSchedulingJob and export it with sendProtectedInvitations for other writers
- Skip protected events' invitations in MeetingSchedulingJob, sending cancellations with the placeholder title
- Name replies and change requests about a protected event by the invitationContent the client sends
- File inbound invitations sealed into a protected calendar when the mail itself isn't zero-access
- Flag a protected event's reminder so the client opens the event for its real title
- Document protected-event invitations and their device limits in the search spec
- Backfill calendar events, contacts and tasks per data type once zero-access encryption protects that type
- Store a protected contact's existing photo again sealed and remove its readable copy
- State in the escrow release that offline tooling opens the sealed fields of events, contacts and tasks
- Mark keyed CalendarEventAttendeeLinks, whose meeting opens only with the key a save supplies after #
- Append each attendee's meeting link key from invitationContent.meetingLinkSecrets while sending, never storing it
- Send a keyed meeting's invitations only at save time, and skip them in MeetingSchedulingJob
- Give save-time invitations each attendee's own video link by building the sender with the attendee-link repository
- Document meetings with per-meeting keys in the search spec
- Cover MeetingInviteSender's guards, the event description placeholders and the backfill budget in isolated tests
- Answer a calendar save that sends a protected event's invitations with the version the claim wrote, and notify it, so the next save isn't refused as stale
- Claim and never mail the save-time invitations of an event its organizer sends encrypted
- Let a create defer its protected invitations to the save that follows with invitationContent defer
- Send a keyed meeting link to no mailbox here whose copy would be stored readable, nor to an unknown address of this server's domains
- Seal the content of an invitation answered from a zero-access message as inbound delivery files it, and keep a sealed event's content sealed when a newer revision is applied
- Apply only the time and new guests of a change request to an event of a protected calendar or with sealed content
- Answer 503 for a zero-access delivery deferred by a pending erasure instead of acknowledging and losing it
- Refuse to process an inline ingest entry another request still holds under a live lease
- Share the scan and attachment text extraction of one delivery between its zero-access recipients
- Skip a stored transport rule that can't be evaluated, quarantine a message the rules can't read, answer 503 when the rules can't be loaded, and convert deeply nested HTML within bounds
- Leave a zero-access message's delivery and feedback reports out of the mail event stream and mark the event zeroAccess
- File a delivery failure notice sealed for a zero-access mailbox
- Keep a sealed imported message whole on a retried import instead of deleting and importing it again
- Index a message dated outside years 1000-9999 into the current week, and leave a stored week that isn't an ISO week out of the manifest
- Apply an emptied protected field from a REST client as a clear, keeping the placeholder echo rule for devices
- Seal a moved record for its destination mailbox, and refuse moving a record with sealed content to another mailbox
- Mark a message the backfill can't seal only when its body is gone or can't be parsed, retrying passing failures
- Seal a contact whose photo blob is gone without it, retry a photo that fails for a while, and mark a record whose sealed write is refused
- Read the zero-access policy once per backfill run and a mailbox's folders only when it has mail to seal
- Treat a plain delete of a model with no soft delete as a purge, so deleting an attachment checks the legal hold, deletes its blob and refunds its quota
- Erase a mailbox's CalendarEventAttendeeLinks with it, leftover data included
- Strike matter export attestations off as they are recorded, and stop once another replica took the request over, so a long list isn't attested twice
- Lowercase a message's text once for all transport rules instead of once per rule
- Take over a stale store lock atomically and release only a lock this call still holds
- Read a shared mailbox's member certificates in a few queries and its access list once per request
- Let only an expired or superseded OpenPGP key vouch for its successor, by a certification made before it was retired
- Fold a header this server writes when it is longer than 998 characters, write RapidMX-Key keydata in runs, and leave out an Autocrypt key longer than peers read
- Record the address a conflicting key was checked against, so a conflict on an alias's contact can be accepted
- Select messages whose encrypted column is NULL for the zero-access backfill, so mail stored on SQL before Message.encrypted existed is sealed too
- Drop the sealed copies of an event that a newer invitation revision replaces, so clients don't open the old title and location over the new ones
- Seal an invitation answered from a zero-access message into sealedContent whenever field sealing left its content readable, also on a copy sealed field by field earlier
- Seal every protected field a record still holds readable on its first protected write, whatever the write carries, a move into a protected mailbox included
- Store a contact's readable photo sealed with its first protected write, and backfill contacts whose fields are sealed but whose photo isn't
- Clear a moved record's zeroAccessBackfillError so the backfill selects it in its new mailbox
- Apply an emptied sealed field as a clear only when the request names it in clearedFields, so a client that couldn't open the record wipes nothing it sends back
- Send a sealed Sent Items copy back to the search index, so the readable draft's document is replaced with its metadata
- Parse with skipHtmlToText in sealRaw, and seal a message mailparser can't read whole instead of leaving it readable
- File the unknown-recipient notice of a zero-access sender sealed and inline, writing no readable ingest blob
- Relay a message the transport rules quarantine to no external distribution list member
- Build the calendar route's and MeetingSchedulingJob's MeetingInviteSender unnamed, so neither is handed the other's host
- Send a keyed meeting link to nobody from a sender that can't tell whose copy may carry its key
- Document clearedFields and complete first protected writes in the search spec
- Name a reply or change request about an event filed from a zero-access invitation by the client's invitationContent, and without it send no SUMMARY rather than the placeholder title
- Never take a sealed event's placeholder title for a guest's requested title change
- Leave a guest's change request to a sealed or keyed meeting a proposal instead of moving a meeting whose guests the scheduling job can't invite
- Send a sealed or keyed meeting's updated invitations when the organizer accepts a proposed time with invitationContent, and refuse the accept without it
- Flag the reminder of an event filed from a zero-access invitation as protected
- Merge a re-published OpenPGP certificate with the pinned fingerprint into the pinned copy, taking in an extended expiry, new subkeys and revocations, from discovery, key headers, trust and resolve
- Record the primary address a locally discovered key of an alias or plus-tagged address was checked against, so its conflict can be accepted
- Keep the revoked certificates a Web Key Directory serves for an address, so a pinned key its holder revoked is marked revoked
- List a mailbox's retired keys most recently retired first in discovery, so a peer keeping eight keys still sees the revocation of the key it pins
- Refuse to change the sender, recipients, subject or Message-ID of a message the server sent, so a recall goes where and as it was sent
- Force the sender of mail outside Drafts to one the mailbox can send as when an update changes it
- Document the change request, proposal and OpenPGP refresh rules in the specs
- Keep every sealed field's placeholder in step with the record as stored, and treat a sent-back stored column as an echo, so a contact's sealed name is never resealed as an old first address
- Send a message the zero-access backfill seals back to the search index with its retries reset, so one whose indexing retries ran out loses its readable document
- Refuse a server-side mailbox import into a mailbox whose mail is zero-access, which would spool the archive readable in the blob store
- Read an HTML body's text for transport rules without a depth or width limit, so a bodyContains rule can't be evaded by nesting or padding the HTML
- Record the relay's sanitized render when filing a sent message fails, and delete one no row names when a send's claim lapsed, so no readable render is orphaned
- Keep an event's title and its sealed copy when a newer invitation revision names no title, sealing a title still readable, and clear a revision's missing location on SQL
- Never write LOCATION in a REPLY or a plain COUNTER, so an attendee's keyed meeting link can't reach the organizer's mailbox
- Invite for a meeting from what it held readable when an update without invitationContent is its first protected write
- Clear the location of a calendar copy answered with a newer revision that names none, so SQL keeps no readable location
- Document the import refusal and replies without LOCATION in the search spec
- Take an inbound key header's effective date from its bottom-most Date and never later than its receipt, and record no observed format for a message with more than one Content-Type, so a future-dated or replayed message can't freeze a contact's preference or format
- Clamp a discovered preference's lastSeen to the time it was observed, and treat a stored lastSeen or observed format dated far ahead of the clock as none, so a preference frozen earlier is superseded
- Strip a merged OpenPGP certificate to the user IDs, subkeys, revocations and direct signatures its primary key signed, so no copy can grow the pinned certificate with third-party certifications, foreign subkeys or forged revocations
- Date a revoked OpenPGP certificate by a revocation that verifies, not whichever is listed first
- Create no contact from a Web Key Directory answer that lists only revoked certificates, so a lookup of such an address answers 404 again
- Send a zero-access message's recall as Recall naming its sent date, and its read and delivery receipts as Read receipt and Delivery receipt, never with the placeholder subject
- Document effective dates, OpenPGP merge filtering and the subjects of notices about zero-access mail in the specs
- Seal one occurrence detached from a series filed from a zero-access invitation into its own sealed content, to the series' key, whatever the calendar's setting, and refuse it (409) when that key is gone, so a drag, resize or single-occurrence edit never stores its opened title, location or description readable
- Index any message still readable in a zero-access mailbox as metadata only, under the placeholder subject, so a draft assembled for sending never has its subject, body or attachment text indexed whatever clears its stamp
- Re-check a message's extracted attachment text only when its document read it, so a sealed message with an attachment keeps its search stamp
- Never extract the text of an attachment of a message stored zero-access sealed
- Look up a sent message's thread inside the step that records the relay's sanitized render, and only best effort, so a database error after the relay never orphans the render
- Take the relay's sanitized render before the conversation lookup in ScheduledSendJob, and look up the thread best effort
- Bound member key wraps per zero-access key and the vault by a larger total, so wraps kept across rotations never block the active key's, and check the bound when an ownerless mailbox's key is provisioned
- Refuse (409) to give an owner to an ownerless mailbox that has zero-access keys, which only its member and escrow wraps open
- Release a matter scope's zero-access escrow wraps whether or not the mailbox has an owner now
- Keep the sealed content of an event filed from a zero-access invitation when a client writes back its placeholders, give a detached occurrence written that way the series' content, and refuse a location or description change sent with the placeholder title
- Treat an event whose content is sealed whole as sealed when inviting: the scheduling job leaves it pending, and a save invites from the content the client opened, never from the placeholder title
- Send a private or confidential event's reminder as its busy block, flagged protected, so a read-only calendar subscriber never receives its title or location
- Keep the title's per-field sealed copy when an answered zero-access revision without SUMMARY puts the event's content in sealed content
- Document metadata-only indexing, the member wrap bound, the owner refusal, escrow release and sealed-content event writes in the search spec
- Read comment text and the text of a style or script inside svg or math, as it is and as HTML once more, after the rest of an HTML body's text, so a bodyContains rule sees what a browser shows past a --!> or bogus CDATA comment or out of foreign content
- Name a zero-access message in its recall notice by the time the server relayed it, not the draft's creation date its sentDate still holds
- Strip an observed OpenPGP copy to what its primary key signed before merging it, so a forged later-dated subkey binding or self-certification can't displace the pin's and strip its encryption subkey
- Name the primary address in an alias-domain key discovery answer only when it lists keys, so a mailbox without keys answers exactly as a local part with no mailbox
- Document the transport-rule text, recall date, OpenPGP pre-merge stripping and discovery address rules in the specs
- Send a message back to the search index when a send moves it into Outbox, queued, scheduled or claimed, as any folder move is, so a readable document it had from before its mailbox turned zero-access is replaced by metadata at once rather than when the sealed Sent copy is filed
- Document the Outbox re-index of a send in the search spec
- Give an owner back to an ownerless mailbox whose zero-access keys are all in its vault under a master key, refusing (409) only while a key has nothing but member and escrow wraps
- Index soft-deleted sealed mail as metadata in what is left of each search batch, so a readable document that outlived its message's deletion or a failed backfill removal is replaced and retried until it is
- Write a backfill draft seal's index entry only after its version-checked update wins, so a losing seal never removes the entry another replica or a compose save wrote
- Refuse an owner's zero-access rotation before issuing its certificate when the members' wraps of the new key wouldn't fit in the vault, so the current key stays active
- Keep a draft's attachment rows and blobs when the backfill seals it, dropping only their extracted text
- Seal an Outbox message whose send failed for good as a draft, and one relayed but never filed as sent mail, leaving a send that can still go ahead alone
- Retry a send's version-checked filing into Sent Items against a fresh read while its claim stands, so a search index stamp landing during sealing no longer fails a delivered send
- Keep the source after a plaintext start tag literally for transport rule matching, as a browser shows it
- Name a sealed booking by the invitation's SUMMARY in a resource's automatic reply, or by none, never by its placeholder
- Put off an attachment of a sealed message instead of stamping it with empty text, so it is extracted once its draft is stored readable
- Leave the sealed copies of a private event's details out of its busy block
- Document the round 5 zero-access fixes in the search spec
- Raise a sealed-content event's sequence only for a scheduling change the server can see or a higher sequence its client sends, never for the placeholder location every opened save differs from, so an attendee's copy keeps applying the organizer's revisions and an organizer's meeting no longer re-invites on every save
- Show the schedule around an invitation as the caller may see each calendar, a busy window without a title where they can't read it and Busy for a private or confidential event without UPDATE
- Give an occurrence detached from a series whose sealed content names no title the series' sealed title too
- Drop an unauthenticated sender's Autocrypt header from a relayed copy whose From is rewritten to the list or the forwarding mailbox
- Delete a truncate's soft-deleted matches too and pass only what was removed to the purge hooks, the search index and the audit, so a ?deleted=true truncate no longer destroys restorable messages' attachments and search documents
- Delete a lazily re-sanitized blob again when the message, read afresh, no longer names it or is sealed, so sealing or erasure racing the rewrite leaves no readable copy
- Restore the mocks after each invitation schedule test, so a failed calendar read no longer leaks into later tests
- Document the relay Autocrypt rule and the sealed-content sequence rule in the specs
- Drop an event's per-field sealed title when its sealed content is resealed with a title, so a rename or an answered titled revision no longer leaves the old title to be opened over the new one
- Record, export and release a sealed draft body replaced under a legal hold, accepting the draft's own mailbox's sealed draft keys as retained bodies
- Delete the sealed blob a zero-access filing stored when writing its index entry fails
- Protect mail:jobs:zero_access_backfill from plugin settings, and test that every core job's mail:jobs namespace is protected
- Clear the SQL key discovery tests' verified domains after the file, so the next file can create mailboxes at example.com
- Record in the notes that activesync already cleans up a Sent Items copy whose filing fails
- Leave out of an invitation card's schedule the busy windows of calendars the caller can't read unless the owner's free/busy visibility shows them that mailbox
- Test that an organizer-owned sealed-content meeting re-invites for a description change only when its client raises the sequence, and note that web-client must raise it
- Write no RapidMX-Key or Autocrypt header for a sender address that isn't ASCII, which could only go out as an unfoldable, unparseable encoded word
- Extract attachments never looked at before failed or sealed-deferred ones, so recurring sealed-draft rows can't fill every batch
- Delete a re-sanitized blob the message no longer names only when no other row names it, serve the reader its HTML when the check fails, and redo a missing sanitized blob from the raw message on read
- Delete a sealed blob on a failed zero-access filing only under a key fresh to that call, never the message's own za/<mailbox>/<uid> that a concurrent filing may name, and take an index entry another filing created meanwhile as written
- Put a sealed draft's attachment off for as long as it is old, up to a day, so an abandoned sealed draft is looked at about once a day rather than every ten minutes
- Clear the extracted text of every attachment row of a draft the backfill seals with a version-bumping write, and store no text for an attachment whose message was sealed while it was extracted
- Serve a former owner's wrapped keys and master key wraps to no FULL holder of an ownerless mailbox
- Seal a soft-deleted Outbox message whatever its schedule says unless a send still holds it, and clear the schedule of every Outbox message the backfill seals
- Cover mayViewFreeBusy() with a caller who owns mailboxes and the loader's swallowed fallback delete failure, which the first CI run left below the coverage threshold
- Record in the notes that web-client now raises the sequence for a sealed meeting's description change
- Clean the rspamd learn request's Deliver-To header to printable ASCII as a scan's Rcpt is, so reports from an internationalized mailbox are learned instead of failing in fetch
- Store a send's threading headers only after its claim, and have ScheduledSendJob apply them to what it relays, so a send never rewrites a draft body a concurrent sealing save or the backfill already deleted
- Clear each attachment row's extracted text with a version-checked write before discardPlaintext() purges it, deleting the text a late extraction stamped
- Seal a delivery failure notice under a key fresh to its filing and delete only that key when filing fails, never the shared index entry
- Ask for headers-only bounces of an invitation carrying a meeting key, and send one through a transport that can't only when the organizer's mail would seal the bounce
- Show an unreadable calendar on an invitation card only as free/busy does: merged busy windows of live calendars, without free or declined events or row uids
- Normalize and sanitize an update's description before sealing it into an event's sealed content
- Refuse an OpenPGP key too large for peers at enrollment, and leave any key a peer would refuse out of the key discovery response
- Count a body blob the store says is gone as no space in the quota recalc, so one lost blob can't keep the figure from coming down
- Delete a purged message's sanitized HTML again after erasure or retention removes its row, so a re-sanitize that wrote it back mid-purge leaves nothing
- Record the round 7 review fixes in the notes
- Keep a soft-deleted scheduled Outbox message readable and scheduled in a zero-access mailbox, so restoring it resumes the send, until deleted_scheduled_send_days (30) after the later of its scheduled time and its deletion, then seal it and clear its schedule
- Force the fixed follow-redirects, nodemailer, source-map-js, handlebars, brace-expansion and undici through resolutions, raise sanitize-html, nodemailer and vite, and ignore only node-forge's unfixed advisory 1240912 in the audit until acme-client or node-forge ships a fix
- Answer "not there" from LocalFsBlobStore.exists() only for ENOENT or ENOTDIR and rethrow any other filesystem error, as S3BlobStore does for anything but a 404, so a permission or I/O fault no longer lowers a mailbox's quota figure or gives up on sealing a body
- Count a body or contact photo the blob store says isn't there as gone only once it has been missing for a while, 6 hours in MailboxQuotaRecalcJob and a day in ZeroAccessBackfillJob, so a blob volume that failed to mount neither drops quota figures nor leaves zero-access mail unsealed for good
- Seal a soft-deleted Outbox message that was already relayed at once rather than after deleted_scheduled_send_days, keeping its filing retry's schedule so a restore still files it into Sent Items
- Find or create the Inbox before sealing a zero-access delivery failure notice, so an Inbox failure can't orphan the notice's sealed blob
- Describe this release's changes in the release notes

### Removed
- Removed RapidMX-Key and Autocrypt headers a message already carries before announcing the mailbox's own keys
- Removed ZeroAccessParseError, which sealRaw no longer throws
- Removed a sealed message's readable search document when its metadata re-index runs out of retries, and keep retrying while that removal fails
- Removed the search document of a soft-deleted message the zero-access backfill seals, which the search indexer never revisits
- Removed the index entry a backfill draft seal replaced when its version-checked update loses, unless the draft was filed as its Sent Items copy or left Drafts to be sent
- Removed a failed seal's blob under the message's own key when the caller minted its uid for that one filing (freshMessageUid)

## [0.34.0] - 2026-10-23

### Added
- Added zero-access keys as useType zero-access, issued by the internal CA and stored on Mailbox.zeroAccessKeys so they are never published through discovery, the RapidMX-Key header or contact keyrings
- Added EncryptionPolicy.allowZeroAccess, defaulting to mail:zero_access:allowed (on), to allow or disable zero-access encryption server-wide
- Added Mailbox.zeroAccessEnabled, unset meaning on, kept only when the mailbox's owner writes it
- Added ZeroAccessUtils with zeroAccessStatus, isZeroAccessActive and activeZeroAccessKey for the effective zero-access state of a mailbox
- Added ZeroAccessSealer to encrypt to a mailbox's zero-access certificate as CMS EnvelopedData (ECDH P-256, AES-256-GCM) with pkijs, matching the client's S/MIME construction
- Added sealMessage to store a message as S/MIME enveloped-data of its full original MIME, keeping only routing headers outside and Subject [...]
- Added sealSummary and sealIndexDocument for a message's sealed subject and preview and its gzipped search index document
- Added isoWeekId for the ISO week (UTC) a message's index entry belongs to
- Added buildIndexDocument to extract attachment text within a time budget and size cap, deferring the rest to the client
- Added ZeroAccessResolver and zeroAccessTargetFor to decide from the stored policy and the mailbox's access list whether and to which key a mailbox's mail is sealed
- Added the ZeroAccessIndexEntry entity and Message.zeroAccess with the key fingerprint and sealed summary
- Added ScanPipeline's includeBodyText option for a message's whole body as text
- Added pkijs and asn1js dependencies, deduplicated to one asn1js
- Added ScanQueueJob.processInline and seal zero-access messages on filing: the S/MIME message in its own za/ blob, a placeholder subject and preview with the real ones in Message.zeroAccess, no sanitized HTML or attachment blobs, and one sealed index entry per filed copy
- Added ZeroAccessFiling and sealEventFields
- Added ZeroAccessWriter, the shared sealer for every writer of message content other than inbound delivery
- Added latestZeroAccess to conversation rows
- Added POST /mailbox/:id/keyvault/exports, recording the owner's export of their zero-access, encryption and signing keys as key_vault.export in the audit log
- Added ZeroAccessWriter.sealDraft, sealing each saved draft of a zero-access mailbox to a fresh za/<mailbox>/drafts/ blob and replacing its index entry
- Added ZeroAccessSealOptions to seal and sealRaw for the blob key and index entry replacement
- Added ZeroAccessIndexSegment and BaseZeroAccessIndexRoute: the zero-access search index manifest, pending sealed entries, segment download and compaction upload with a compare-and-swap on the generation and the folded entry uids
- Added mail:zero_access:compaction_grace_hours and max_segment_bytes
- Added ZeroAccessBackfillJob, sealing the mail a mailbox already had when zero-access encryption became active, newest first, and removing its readable copies
- Added Message.zeroAccessBackfillError for a message the backfill can't seal
- Added KeyVault.memberKeyWraps, each wrapping a shared mailbox's zero-access private key to a member's own zero-access certificate
- Added the member key routes: the members' key status, the caller's own wraps, fulfilling and removing wraps, and provisioning a mailbox-without-an-owner's key together with its wraps
- Added PUT /:id/keyvault/escrow-wraps for full-access members to add the escrow copies a scope is missing, and report them as escrowPending in the members status

### Changed
- Adopt zero-access encryption in the search and E2E specs with a dedicated never-published zero-access keypair wrapped under MK
- Replace the three-state zero-access policy with a server-wide allow setting and an owner-only per-mailbox enable setting, both on by default
- Replace the server hot segment with sealed per-message index entries that clients compact into weekly FTS5 segments
- Encrypt index entries and segments to the zero-access public key and drop the symmetric wrappedIndexKey
- Specify inline delivery for zero-access recipients with no plaintext spool, sealing on every content write path including drafts and Sent copies
- Specify member key wraps for shared mailboxes and backfill of existing mail on enablement
- Record the zero-access standing decisions in NOTES.md
- Return the mailbox's zeroAccessKeys with every key vault response so an unlocking client can decrypt zero-access mail
- Refuse a client-set zeroAccessKeys like keys
- Make supersedeKeys generic over the key type
- Protect mail:zero_access from plugin settings
- Process a zero-access recipient's message inside the ingest request from the raw message in memory, with no plaintext ingest blob, answering 503 so the MTA retries on failure
- Record the zero-access key on the IngestQueueEntry and keep the scan queue from ever picking such an entry up
- Keep a retried transaction's first decision per recipient, building a new entry's fields only when it is created
- Seal zero-access quarantined messages, including over-quota ones
- Leave the subject out of message.delivered events for zero-access mail
- Seal an invitation's title, location and description into CalendarEvent.sealedContent for zero-access mailboxes, and apply only time changes from a guest's change request to such an event
- Seal the Sent Items copy of a message sent now or in the background for a zero-access mailbox, removing the draft's plaintext body and attachments
- Seal messages imported by MailboxImportJob into a zero-access mailbox, rolling back the sealed blob and index entry when filing fails
- Answer GET /messages/:id/content with 409 for a zero-access message
- Read the encryption policy uncached when deciding zero-access
- Register the zero-access models in the SQL import and scheduled send job tests
- Refuse to send a draft stored zero-access sealed, with 409 from POST /messages/:id/send and a refusal from ScheduledSendJob
- Teach the spam filter a reported zero-access message from the client's decrypted copy (rawMessage), checked against its Message-ID and never stored, else skip learning as zero_access
- Keep Authentication-Results among a zero-access message's outer headers so its sender's DKIM verification still applies
- Accept the calendar file a client decrypted (ics) for the invitation of a zero-access message on every invitation endpoint, adding POST /invite/:messageUid/view
- Index a zero-access message's metadata without fetching its sealed blob
- Document that data exports carry zero-access messages as their sealed copies
- Refuse to store a search index segment not encrypted to one of the mailbox's zero-access keys, checked with isSealedToCertificate
- Count a mailbox's pending index entries per week with one grouped query
- Define search index segment format version 1 as a sealed, gzipped JSON bundle of index documents, and compaction by folded entry uids, in the search spec
- Leave search index segment format version 2 unscheduled until segment import cost is measured, adding that measurement to the search spec
- Make Message.zeroAccess and zeroAccessBackfillError server-managed
- Purge a mailbox's zero-access search index entries and segments when it is erased
- Release a mailbox's wrapped zero-access and encryption private keys and their certificates with its escrow material, never its signing key
- Seal an edit of a calendar event made from a zero-access mailbox's invitation again, refusing it when the key is gone, and ignore a client's sealedContent
- Seal mail for shared mailboxes too, now that their members read it through member key wraps
- Read a mailbox's members from its access list uncached when deciding who holds its key
- Escrow a mailbox-without-an-owner's zero-access keys straight to its escrow scope's certificate, in KeyVault.zeroAccessEscrowWraps
- Require an escrow wrap when provisioning the key of a mailbox without an owner that is assigned to an escrow scope, written in the same transaction
- Release the matter scope's zero-access key escrow wraps of a mailbox without an owner from an escrow access request's material
- Record in NOTES that Source C client segments are built and imported by web-client, needing no restapi change
- Describe zero-access encryption in the release notes

## [0.33.0] - 2026-10-09

### Added
- Added startAlarmSentFor claim marker to CalendarEvent models and treat it as server-managed
- Added start-alarm tests for the Mongo and SQL reminder jobs
- Added ContactAddressKind.MOBILE, Message.replyTo, and MessageFlags.lastVerbExecutedAt, closing data-model gaps a downstream package (the activesync plugin) needs to map EAS fields this server had no way to represent at all
- Added a CLDR-generated Windows time zone id to IANA zone mapping with ianaZoneForWindowsZone, windowsZoneForIanaZone, and currentIanaZone
- Added the CLDR source data and the generator script for the Windows zone mapping

### Changed
- Fire a calendar event's alarm at its start time even when it has no reminder
- Claim each alarm kind separately in CalendarReminderJob and key the next-due cache per master and kind
- Skip the start-time alarm for all-day events
- Message.replyTo is wired at ingestion (ScanQueueJob.deliverMessage, both the primary and copy-rule paths) from ScanPipelineResult.replyToAddress, which was already extracted but never stored. lastVerbExecutedAt is purely additive - restapi itself never sets answered/forwarded, so there is no internal write path to add alongside it
- Resolve every Windows zone id in resolveTimeZone instead of a 10-entry table

## [0.32.0] - 2026-10-07

### Added
- Added a Suggested Contacts folder type that is created lazily and never client-created
- Added Correspondent.suggestedAt marking the people already turned into suggested contacts
- Added POST /mail/directory/suggested-contacts to fill the Suggested Contacts folder from existing mail history

### Changed
- Create a Contact per correspondent in the Suggested Contacts folder with SuggestedContactUtils

## [0.31.0] - 2026-10-05

### Changed
- Export MeetingInviteUtils from the public util barrel so downstream protocol packages can reuse invite parsing

## [0.30.1] - 2026-10-04

### Changed
- Publish a prerelease version to npm under the next tag, which npm requires, and a release under latest
- Treat the rspamd greylist action as clean, and send a message whose spam verdict is only suspect rather than refusing it with a 422 unless the scan engine was unavailable

## [0.30.0] - 2026-10-03

### Changed
- Build the repositories of the additional models of every route once in a single @Init hook, rather than lazily in the method that uses them or in an init() that each handler called, and keep the hooks of the classes that share a base under names that cannot shadow each other
- Build the repositories that a job used to make on demand, or on every call, in its @Init hook, and make its repositories protected
- Build a repository the routes made on every call only once
- Inject the extraction registry into the job that extracts attachment text so that its limits and its logger are configured, and stop its worker thread when the server shuts down
- Take the extractors of the extraction registry, the health of a signing enrollment and the loader of sanitized bodies from the ObjectFactory instead of making them with new
- Read the type of the SQL database of the scheduled send job from its own configuration key and take the model of the erasure requests of the scan queue job from its binding rather than from the name of another class
- Record the audit log through an AuditLogUtils service that is built once from the audit log repository, rather than through a function that took the ObjectFactory and the model class on every call
- Resolve the domains of a mailbox, record the escrow audit chain and keep the correspondents of a mailbox through DomainUtils, EscrowAuditUtils and CorrespondentUtils services, with the backfill of the correspondents in its own service
- Pass the repository instead of the ObjectFactory and the model class to the utilities for the legal hold, the escrow holder, the folder of a record, the blob references, the purge of a message, the content of a mailbox and the policy of a mailbox
- Take the repositories and services that the routes and the jobs need from their @Init hooks, and stop caching the repositories of the utilities by model class, which could hand one ObjectFactory the repository of another
- Fall back to the unkeyed hash with a warning when the key of the escrow audit chain is not set, as the old function did

## [0.29.0] - 2026-10-02

### Changed
- Install a plugin from an npm pack file uploaded by an elevated administrator, storing the pack in the blob store and recording its integrity, with a switch and a size limit for the operator
- Inspect an uploaded pack without extracting it, refusing anything that is not a gzipped tar of a package, an unsafe or oversized one, or one with an invalid manifest
- Replace an installed plugin with an uploaded pack of the same name, keeping its settings and whether it is enabled, and go back to the registry through an update
- Leave the plugins that were uploaded out of the checks for updates

## [0.28.1] - 2026-10-02

### Changed
- Protect the server's own jobs by name rather than every job, and no longer the autodiscover settings, so the ActiveSync and autodiscover plugins still load
- Update nodemailer to 10.0.13

## [0.28.0] - 2026-10-02

### Changed
- Cap the recipients and the field lengths of the delivery status and feedback reports published on the mail event stream, and mark whether the report came from an authenticated sender
- Stop an administrator setting a contact's picture to another blob, and only erase a picture from the contact's own folder of the blob store
- Make a contact's picture revalidate on every request, so a revoked or deleted picture stops showing at once
- Stop a Redis outage from holding up sending and delivery by giving up on publishing to the mail event stream after two seconds
- Index the picture of a contact so removing or replacing one does not scan every contact
- Return the plugins one of the two registry searches found when the other fails
- Say on a published delivery status or feedback report when recipients beyond the cap were left out
- Fall back to two seconds when the time to wait for the mail event stream is not a positive number, and say in the log that a publish given up on may still be delivered
- Stop any caller, an administrator included, from setting the blob keys of a message, an attachment or an ingest or quarantine entry, and refuse to create the entries through the API
- Find a soft deleted folder when working out the mailbox of a record and refuse to create or move a record into one
- Require an elevated administrator to change the owner of a mailbox, delete another's mailbox, empty the mailboxes, change the retention policy, export another mailbox or approve an erasure, and keep the one who asked from approving their own
- Require an elevated administrator to write transport rules and to add, update, remove or plan plugins, and stop an elevation older than fifteen minutes from counting
- Refuse to create a mail folder type through the API and ignore the type on an update
- Force the sender of a message made outside Drafts to the mailbox's own address and scrub a draft moved to Deleted Items
- Let only a message the server relayed be recalled, send the notice once, keep Bcc recipients out of it and limit how often it is done
- Freeze the subject, sender, recipients and dates of a message under legal hold, and hold the attachments of such a message too
- Delete the blobs of an attachment and give back its quota when it is purged
- Require the organizer of an invitation to be the sender, verified, before answering, removing or accepting it
- Check the filter rule forwards, cap them and their actions, and audit them
- Keep a delegate from reading the key vault or wiping the published keys of a mailbox
- Bound the actions of a share link to what its creator holds, cap the links of a calendar and expire them
- Check the custodians of a matter against its escrow scope, rate limit and audit its searches and exports
- Mask the secret settings of a plugin, including those its manifest names, and let it set only the keys its manifest declares outside the server's own configuration
- Validate the transport rules, the domain names and the urls and styles of the branding
- Make the MTA delivery repeatable, and stop answering a retry after the external relays went through
- Use a LIKE escape that MySQL accepts
- Search only for single strings and leave out soft deleted messages
- Stop an unscanned self declared encrypted body from skipping the attachment scan
- Rebuild the recurrence rule of an invitation from validated parts, treat an invalid rule as no recurrence and bound the work of expanding one
- Treat a truncated expansion as busy in free and busy
- Make the mbox parser linear and cap the size of a message
- Encode the header values added to a message so a character cannot turn into a line break, and check the sender of the final message
- Keep the leading headers of a list and a transport rule from being forged, and honour the null sender in bounces
- Check the certificate of a first pinned key and of the one the OpenBao CA issues, and refuse discovery hosts that resolve to private addresses
- Limit the signing certificate enrollments and refuse one made before its mailbox
- Close the websocket of a user who lost the channel and refuse an origin the CORS settings do not allow
- Create the files of the local blob store readable by the server alone and lock the shared files across replicas
- Keep the Postgres columns as they are and widen the text columns for MySQL only
- Do not delete the source of a mailbox import that lost its claim, and clean up a message half imported
- Keep an erasure request that failed to purge open, stop one held request from starving the others, and end a request that keeps failing
- Charge a delivery once, give it back when it failed and drop mail for a mailbox that is gone
- Recalculate the quota without losing a charge made meanwhile, counting the soft deleted
- Include the soft deleted content in matter exports and keep the escrow attestations from being written twice
- Purge dead ingest entries and the audit log of held mailboxes, and cap the contacts made from key headers
- Check the domains never checked first

## [0.27.1] - 2026-09-30

### Changed
- Find plugins in a namespace even when the npm registry's scope: search index lags behind or answers nothing, by also searching for the scope's name and merging the results

## [0.27.0] - 2026-09-30

### Added
- Added a mail event stream plugins can read (MailEventStream, MailEventConsumer): message.delivered for every filed message, message.sent and send.failed for what the mail transport accepted and refused
- Added structured parsing of delivery status notifications and abuse feedback reports (DsnParser), with each bounced recipient classified as a hard bounce, soft bounce, delay or delivery
- Added contact pictures: PUT, GET and DELETE /:id/photo on the contacts route store, serve and remove a contact's own JPEG, PNG, GIF or WebP picture (up to 1 MiB, checked by its magic bytes), kept in the blob store under the contact
- Added resolveFrom to app rail entries in a plugin manifest: an API path the web client asks about the signed-in user, showing the entry only when it answers with a link

### Changed
- Publish message.delivered from inbound delivery, carrying the parsed bounce or feedback report and the envelope recipients exactly as given
- Publish message.sent and send.failed from immediate and scheduled sends through a new optional argument of scanAndRelay()
- Build the bounce preview from the parsed delivery status report

## [0.26.0] - 2026-09-30

### Added
- Added a correspondents search to the directory so addressing suggests anyone the user has corresponded with, not only their contacts

### Changed
- Remember the people each mailbox has exchanged mail or shared an event with, from delivered, sent and scheduled mail and from calendar events and invitations
- Build a mailbox's list of correspondents from its existing mail and events the first time it is searched
- Delete a mailbox's correspondents when its data is erased
- Pin undici (via node-gyp) to a fixed version in resolutions - the validate job's yarn npm audit now fails on a high severity advisory (denial of service through an unrequested WebSocket subprotocol) in the 6.27.0 the ^6.25.0 range resolved to

## [0.25.2] - 2026-09-29

### Added
- Added the missing "Enable corepack" step to the validate job - every other job already has it, and without it yarn runs the container's stock Yarn 1.22.22 instead of the packageManager-pinned version, which refuses to run at all against a packageManager field, so validate's yarn npm audit never actually ran regardless of real findings. Confirmed on rapidmx/server's identical job via a real CI log; this repo's validate job is the same template and shares the same latent gap even where it happened not to manifest yet

### Changed
- Send out-of-office auto-replies with a text/plain alternative and a complete <html> document

## [0.25.1] - 2026-09-28

### Changed
- Cover BasePluginRoute.newestSearchResult()'s catch branch (a package that can't be read during search keeps the search result's own version) - the v0.25.0 CI build failed a 100% coverage threshold on this exact line, left untested by the prerelease-filtering change
- Pin brace-expansion (via minimatch's 1.x and 5.x lines) and tar (via node-gyp) to fixed versions in resolutions - the same CI run's non-blocking validate job failed yarn npm audit on real high/critical CVEs in these transitive dev dependencies
- Document the standing wait-for-green-CI-before-releasing rule in NOTES, per JP

## [0.25.0] - 2026-09-28

### Added
- Added ?prerelease=true to the plugin updates, search, registry and plan routes so pre-release versions count, with releases only by default, and answer any other value with a 400
- Added pickLatestVersion and isPrereleaseVersion to PluginUtils
- Added ServerInfoRoute for auto discovering auth-server URL

### Changed
- Leave pre-releases out of a package's version list unless they are allowed, keeping the installed version, and default a lookup or plan to the newest allowed version
- Test choosing the newest version, and the prerelease parameter on both backends against a registry whose latest tag is stale
- Document the change in the release notes and NOTES

### Fixed
- Fixed a plugin published as pre-releases never showing an update, by choosing its newest version from every published version instead of the registry's latest tag, which is often stale

## [0.24.0] - 2026-09-26

### Added
- Added configured to the plugins the plugin routes return, with what the command line, the environment and the server's defaults set for each declared setting, so the admin console can show the value in effect

### Changed
- Leave a secret's value out of it, and the layer that holds the settings saved on plugins, which wins over the rest
- Test configuredPluginSettings against the server's real layers and withConfigured on the route
- Document the change in the release notes and NOTES

## [0.23.0] - 2026-09-26

### Added
- Added POST /messages/:id/report, which moves a reported message to Junk Email or, for not junk, to the Inbox, teaches rspamd through its controller's learnspam and learnham, records reportedAs and an audit entry, and can add the sender to Safe Senders
- Added per-mailbox blocked and safe sender lists, changed one entry at a time by POST and DELETE on /mailboxes/:id/blocked-senders and safe-senders with a version-checked retry and only by a caller with full access, so a blocked sender goes to Junk and an authenticated safe sender is not sent to Junk by the spam verdict, while infected mail and policy quarantine are never rescued
- Added fromEquals and fromDomainEquals to filter rules, matching the header From and the envelope sender exactly, so blocking ann@x.com no longer matches joann@x.com

### Changed
- Document that a downstream package's release bump level follows its upstream dependency's, minor for minor, patch for patch and major for major, in NOTES
- Delete a purged message's attachments and the blobs no other row references, on a single purge and on emptying a folder, audit emptying a folder, and leave matter ids out of the legal hold refusal for callers without a trusted role
- Test the report, the lists and their enforcement, the exact-match conditions, the rspamd wire calls and the purge on both backends
- Document the change in the release notes and NOTES

## [0.22.1] - 2026-09-25

### Changed
- Run MeetingSchedulingJob every 10 seconds by default instead of every 5 minutes, so the guests of a deleted or cancelled meeting are mailed within moments
- Document the change in the release notes

## [0.22.0] - 2026-09-25

### Added
- Added GET /mailboxes/leftover, which lists deleted mailboxes that still have data, and POST /erasure-requests/leftover, which files an approved permanent erasure of that data through the existing erasure job, refusing a mailbox that still exists and one covered by a legal hold, for administrators with an elevated token
- Added DELETE /mailboxes/:id?erase=true to delete a mailbox and erase its data in one step, and tell every delete whether its data was kept or is being erased

### Changed
- Test the routes, the job and the utilities on both backends
- Document the change in the release notes and NOTES

### Removed
- Removed a deleted mailbox's own ACL when the erasure job purges it, and give the create 409 for a stuck address a reason, so a client can offer to erase the data or show the erasure that is running

## [0.21.1] - 2026-09-25

### Changed
- Document the fix in the release notes

### Fixed
- Fixed the repository URL in package.json to the lowercase path, https://github.com/rapidmx/restapi.git

## [0.21.0] - 2026-09-25

### Added
- Added a <host> placeholder for a string plugin setting's default, filled in with the host the request reached when the plugin is installed (or a new version declares the setting with no value) and left unset when no host is known, so a plugin such as the video-conferencing join page works as installed
- Added GET /system/plugins/registry?name= as the same registry lookup with the package name in the query string, because Envoy Gateway unescapes the %2F of a scoped name in the path and redirects to a path that matches no route, which made every scoped package fail to look up
- Added answering the meeting invitation in a message as Outlook does: GET /calendar-events/invite/:messageUid reads the calendar file from the stored raw message and reports what it is, who organized it, whether it is on the reader's calendar, what they answered and which of respond, propose, add, remove and accept-proposal apply
- Added POST .../respond, which puts an accepted or tentative meeting on the calendar at the uid inbound processing uses (or updates the answer on the copy that is there), removes it on a decline, and mails the organizer an iTIP REPLY either way
- Added POST .../remove for a cancellation, POST .../propose to mail the organizer an iTIP COUNTER with a proposed time, and POST .../accept-proposal to move a meeting the reader organizes to the time a listed attendee proposed and re-invite everyone
- Added Message.meetingMethod, set when a message is delivered, and Message.meetingResponse, kept because a decline leaves nothing on the calendar, and carry the latest message's on each conversation row so a list can show an RSVP button
- Added MeetingInviteUtils with the pure parts of the above
- Added description to a calendar event as sanitized HTML plus a plain-text copy, sent in the invitation as DESCRIPTION and X-ALT-DESC, sanitized again when read from a received invitation, and shown on the invitation card
- Added event visibility (default, public, private, confidential), carried as CLASS, and show a private or confidential event to a reader who cannot update the calendar only as a busy block, in lists, single reads, counts, sorts and live updates
- Added guest permissions (guests can modify, guests can invite others, guests can see the guest list), carried in the invitation as X-RAPIDMX properties, and mail each guest an invitation naming only themselves and the organizer when the guest list is hidden
- Added POST /calendar-events/:id/request-change so a guest whose copy allows it can ask the organizer to change the title, location, description or time or to add guests, which the organizer's server applies and re-invites when the event allows it and shows as a proposal otherwise
- Added POST /calendar-events/free-busy, which returns the busy times of up to 50 local mailboxes over up to 31 days without titles, marks unanswered and tentative time as tentative, and reports non-local addresses as unknown instead of free
- Added Mailbox.freeBusyVisibility (domain, shared, nobody, everyone), changed only by an owner-level caller, to choose who may see a mailbox's free and busy times

### Changed
- Accept the caller's time zone on POST /mailboxes/auto-provision and store it when it is a valid IANA name (isValidTimeZone()), else UTC
- Test the host placeholder on install and upgrade, the query-string registry lookup on Mongo and SQL, and the time zone on auto-provision
- Document the changes in the release notes
- Read a calendar file that names no METHOD as a PUBLISH so an exported event can be added, and let buildEventIcs build a COUNTER
- Return the reader's own schedule around the meeting and the busy conflicts inside it, expanding recurring events and honoring moved occurrences
- Test the endpoints on both backends, including concurrent writes, and test the utilities and the delivered method
- Document the change in the release notes and NOTES
- Fold every iCalendar line over 75 octets, so invitations are no longer quoted-printable when they are all short
- Test the new fields, redaction, guest changes, hidden guest lists, free/busy visibility and the request limits on both backends
- Document the changes in the release notes and NOTES
- Read a missing X-RAPIDMX-GUESTS-CAN-INVITE as allowed only in an invitation whose PRODID names a RapidMX server, so an invitation from another vendor's server no longer offers Add guests, which only a RapidMX organizer's server acts on
- Test both, and document them in the release notes and NOTES

### Fixed
- Fixed accepting a meeting invitation after declining it failing as a duplicate, by clearing the soft-deleted copy that still held the uid before filing the new one

## [0.20.1] - 2026-09-24

### Added
- Added tests for the drain behavior (small/chunked/over-limit/stalled/errored/already-ended bodies), the mid-stream quota-limit 413 in create(), and MailboxImportJob's best-effort source-blob delete failing after a request is attempted or abandoned (SQL and Mongo). Update BaseMailboxImportRoute.test.ts's stale req fixture to a realistic streaming request, and document the fix in RELEASE_NOTES.md.

### Changed
- Drain a small rejected upload body in BaseMailboxImportRoute.create() so its 4xx errors reach the client instead of a reset connection, and close the remaining coverage gaps
- @rapidrest/service-core 2.3.0 force-closes a @StreamingBody() route's connection when it responds before the whole request body has arrived, so every rejection create() makes ahead of the blob write (400/403/404/413) surfaced as ECONNRESET / "socket hang up" instead of its JSON error. create() now reads and discards a small rejected body first (discardSmallBody(): nothing read when Content-Length declares more than 1 MiB, otherwise capped at 1 MiB and 5 s), leaving a huge or stalled upload to the framework's forced close. The pre-stream checks moved into resolveUploadTarget()/storeUpload() with unchanged behavior.

## [0.20.0] - 2026-09-23

### Added
- Added regression tests for ScanQueueJob's iTIP retry-on-409 and deterministic-uid dedup fixes, covering a retry that succeeds, a retry that exhausts all attempts, and two concurrent REQUESTs colliding on the same CalendarEvent uid
- Added BlobStore.localPath() (optional; LocalFsBlobStore returns the blob's own real path, S3BlobStore returns undefined) and MailboxImportJob.resolveLocalSourcePath(), which uses it directly when available or otherwise streams the blob once to a temp file, cleaning that file up on both success and failure of the download itself
- Added unit-style coverage (mirroring BaseFolderRoute.test.ts's own internals-focused pattern) proving the route streams - never buffers into a Buffer - against a real LocalFsBlobStore and a mocked-S3BlobStore, plus the mid-stream-413/empty-body-400/blob-cleanup and defensive-guard branches, and document the change in RELEASE_NOTES.md/NOTES.md, closing out the PST-import size-limitation issue
- Added regression tests for each of the above across both backends where applicable and document the findings in NOTES.md/RELEASE_NOTES.md

### Changed
- Close an SSRF bypass in federation key-discovery via decimal/octal/hex IP notation, re-checking net.isIP() against the URL-parser-normalized host and restricting discovery ports to an allow-list
- Apply the same non-alias-domain restriction to aliasAddresses supplied at mailbox create time, for both trusted and self-service callers
- Resolve alias domains in the public federation key-discovery endpoint so a peer querying an alias-domain address finds the primary mailbox's published keys
- Extract MailboxImportJob's quota charge/refund loop into a shared util/MailboxQuotaUtils.ts and wire it into BaseAttachmentRoute.upload(), enforcing mailbox storage quota and a max-upload-size ceiling at write time
- Cap BaseMailboxImportRoute.create()'s upload size before any processing starts, closing an OOM risk from buffering an unbounded PST/mbox file into memory
- Switch RetentionEnforcementJob.purgeSortedBatches() from offset to keyset pagination on uid, fixing a bug where a post-commit delete failure could silently skip a due row
- Retry ScanQueueJob's iTIP REPLY/CANCEL/REQUEST-update handlers on a version conflict instead of silently dropping the mutation, and derive a deterministic CalendarEvent uid for new iTIP REQUESTs to prevent duplicate-delivery double-booking
- Flag __proto__/constructor/prototype as unsafe keys in RequestBodyUtils.isPathKey(), defense-in-depth alongside the existing dotted-path/$-operator checks
- Make BaseMatterRoute/BaseEscrowAccessRequestRoute/BaseEscrowAuditLogRoute's client-query $-operator stripping segment-aware, matching every other route in this codebase
- Percent-decode X-Envelope-From/X-Envelope-To in BaseMailIngestRoute.deliver(), matching the MTA ingest client's own new encoding of each envelope address
- Validate DistributionList.aliasAddresses (domain restriction and cross-mailbox/list collision check) exactly like Mailbox.aliasAddresses, which had no validation at all
- Re-enable ScanQueueJob inbound-delivery mailbox quota enforcement, this time skipping the charge (rather than failing delivery) when chargeMailboxQuota() finds no Mailbox row, fixing the 75 test failures that caused the prior revert
- Lower BaseMailboxImportRoute's DEFAULT_MAX_IMPORT_BYTES from 500 MiB to 90 MiB and warn once if mail:import:max_bytes is configured at or above the framework's own max_body_size, since the prior default sat above the reference deployment's max_body_size and could never actually reject anything
- Close this project's 100%-coverage gate: add tests for ScanQueueJob's quota-exceeded quarantine and unexpected-charge-error propagation, four updateCalendarEventWithRetry() stale-on-retry edge cases per backend, MailboxImportJob's authoritative (not just cached) quota-exceeded path, BaseMailIngestRoute's malformed-percent-encoding fallback, and KeyDiscoveryClient's URL-parse-failure fallback
- Stop MailboxImportJob from buffering an entire PST/mbox upload (or every reconstructed message) into memory: extractPstMessages()/parseMbox() are now AsyncGenerators reading and yielding one message at a time directly off a file path instead of returning a Buffer[] built from a fully-buffered source
- Have PSTFile read off pst-extractor's own file-path constructor (a real file descriptor, bounded/random-access reads) instead of an in-memory Buffer, closing its own fd once extraction finishes
- Raise BaseMailboxImportRoute's DEFAULT_MAX_IMPORT_BYTES from 90 MiB to 200 MiB now that MailboxImportJob's own memory footprint is fixed, an interim number pending a real streaming-upload fix since the upload itself is still fully buffered by the framework
- Bump @rapidrest/service-core to ^2.2.0 for its new opt-in streaming request bodies (streamingBody/@StreamingBody(), req.bodyStream)
- Register BaseMailboxImportRoute.create() with @StreamingBody() and pipe req.bodyStream straight into BlobStore.put() instead of buffering the whole upload into req.rawBody first, closing the "upload itself is still fully buffered" gap Phase A's own commit left open
- Enforce mail:import:max_bytes against the actual streamed byte count: a Content-Length pre-check before req.bodyStream is ever touched or any mailbox/folder lookup runs, plus a running byte count during the stream that aborts (cleaning up the partial blob) the moment it's exceeded regardless of what Content-Length claimed
- Raise DEFAULT_MAX_IMPORT_BYTES from 200 MiB to 50 GiB now that the upload is genuinely streamed end to end for both LocalFsBlobStore and S3BlobStore, and drop the now-inapplicable max_body_size cross-check a streaming route's framework-level size enforcement no longer runs
- Reject a published push message whose own 'from' field claims a different identity than the authenticated caller in MailPushRoute.send(), closing a WebRTC-signaling identity-forgery gap in the shared BasePushRoute channel
- Reorder BaseEscrowAccessRequestRoute's create()/approve()/material() to call requireEscrowHolder() before any request/matter state check, matching deny()/findById()'s already-correct order and closing three state-oracle leaks for non-holders
- Delete a mailbox import's uploaded source blob in a finally block covering every outcome of MailboxImportJob.processRequest(), plus at reclaimAbandonedRequests()'s own max-attempts terminal path, closing a permanent storage leak now that imports can be up to 50 GiB
- Reject a mailbox-import upload upfront in BaseMailboxImportRoute.create() when the target mailbox is already at quota or a declared Content-Length exceeds its remaining quota, and cap the mid-stream byte limit to whichever of mail:import:max_bytes/remaining quota is smaller
- Document S3BlobStore's multipart 10,000-part ceiling relative to the new 50 GiB import default
- Clear Message.searchIndexedAt in BaseMessageRoute.prepareUpdate() whenever folderUid/flags/labelUids actually change, so a moved/flagged/labeled message gets re-indexed instead of going stale in search results
- Nudge BaseMatterSearchRoute.search()'s date-range clamp 1ms past the matter's own boundary before handing it to a SearchProvider, since every provider treats before/after as exclusive while matter coverage itself is inclusive on both ends
- Reject a repeated structured-filter query key (e.g. ?subject=a&subject=b) with 400 instead of crashing with 500 in BaseSearchRoute/BaseMatterSearchRoute via a new assertSingleStringParam() guard
- Mirror test/routes/sql/MatterSearchRoute.test.ts's date-boundary assertions to the mongo file's +1ms/-1ms inclusive-clamp fix, closing the one gap left by the prior interrupted session (its own SQL test file was never updated for that fix)
- Upgraded deps

### Fixed
- Fixed BaseMailboxRoute.validateAliasChange() using getVerifiedDomainNames() instead of getPrimaryDomainNames(), which let a caller hijack mail by claiming an address on a pure alias domain
- Fixed stale @rapidmx/videoconf-plugin doc references to @rapidmx/meet-plugin
- Fixed an in(...)-operand injection in BaseDataExportRoute.find()/BaseMailboxImportRoute.find() by building the visible-mailbox filter with exactInFilter() instead of a raw comma-joined string, closing an IDOR that let a crafted comma-containing mailbox uid leak another mailbox's export/import requests

### Removed
- Removed a purged or truncated entity from the search index via a new opt-in BaseScopedChildRoute.searchEntityType (set by BaseMessageRoute to "message"), so a permanently deleted message no longer stays searchable forever

## [0.19.0] - 2026-09-22

### Added
- Added CalendarEventAttendeeLink, a plugin-agnostic record of a URL for one attendee of one calendar event, and CalendarEvent.videoMeetingUid marking an event a video meeting is attached to
- Added Domain.aliasOf so a domain can be a pure alias of another, with no mailboxes of its own
- Added getPrimaryDomainNames, getAliasDomainNames and resolveDomainAlias to util/DomainUtils.ts

### Changed
- Personalize each attendee's meeting invite with their own link when one is on file for the event, composing and scanning once per attendee instead of once for the whole event, never adding a query for an event without one
- Fall back to the event's plain location for an attendee with no link on file or when the lookup itself fails, logged, never aborting the send
- Test every case on both backends, including a direct assertion that no attendee-link query ever runs for an event without one, and that a scan refusal now costs only that one attendee instead of the whole send
- Document the change, including the one real behavioral difference it introduces, in the release notes and NOTES
- Restrict new Mailbox/DistributionList addresses (create, rename, self-service, the /mailboxes/domains list) to non-alias verified domains
- Resolve an alias domain to its primary in BaseMailIngestRoute's mailbox/distribution-list address lookup, so inbound mail addressed to the alias delivers correctly
- Let BaseMessageRoute.assertSenderAllowed accept a mailbox's own local part on every alias domain of its own domain, with no per-mailbox configuration
- Resolve the same alias in LocalKeyDiscoveryUtils so federation key discovery for an alias address finds the primary mailbox's own keys
- Validate aliasOf on create and update in BaseDomainRoute: must name an existing non-alias domain, no self-alias, no chains, and refuse turning a domain with dependents into an alias
- Refuse deleting a domain that another domain still aliases
- Guard resolveDomainAlias against an unset domainClass so a lightweight test double that never wires one up keeps working
- Test the new behavior across both Mongo and SQL backends, including the alias-domain delivery, sender and admin-validation paths
- Document the feature in the release notes and NOTES
- Restore the Domain.aliasOf release note bullet dropped by a concurrent edit collision in 0d6e922
- Carry the event's own location in CalendarReminderJob's reminder push event, alongside eventUid/title/startDate
- Test that a real location value comes through unchanged on both backends, fixing two existing SQL assertions for a null location where Mongo's absent field stays undefined
- Document the change and the Mongo-vs-SQL null/undefined difference it surfaced in the release notes and NOTES

### Fixed
- Fixed linter errors

## [0.18.0] - 2026-09-22

### Added
- Added a default autodiscover.public_url config block and fix its plugin's stale documentation, so Autodiscover has something real to point clients at once an administrator sets it
- Added the two DNS record types EAS and Outlook clients actually need to find this server automatically, an autodiscover.<domain> CNAME and a _autodiscover._tcp.<domain> SRV record that needs no extra certificate, only shown when the Autodiscover plugin is active
- Added DnsResolver.resolveCname and resolveSrv, needed to check the new records
- Added resolving a mailbox's owner and an escrow scope's key holder before either is saved, each gated at least as strictly as the write it feeds, so an administrator confirms the actual person before typing a raw uid blind

### Changed
- Test both new record types across Mongo and SQL, including a dedicated server instance for a real configured public_url, since it binds at construction and can't vary per test otherwise
- Document the fix and the operator runbook for powerlevel.gg in the release notes and NOTES
- Lift mailbox sharing's exact-match address, username, alias or uid resolution into a shared util, so it can serve other fields that grant access by uid without repeating it
- Test both new resolve endpoints, and the shared resolution logic against mailbox sharing's own full suite to prove its behavior is unchanged
- Document the fix and what was confirmed already fine in the release notes and NOTES
- Require an elevated token, not just a trusted role, for every escrow scope management action - configuring who holds escrow keys, how many are required, and the scope's own public key
- Leave the M-of-N access request approval flow and a holder's own audit log visibility unchanged, since both are deliberately usable by non-admin holders by design
- Test every escrow scope action against an anonymous, an ordinary and an unelevated administrator caller, on both backends
- Document the fix and the design boundary it deliberately stops at in the release notes and NOTES

### Fixed
- Fixed a guard test that called updateBulk with no user at all, now refused for elevation before it ever reaches the guard it meant to test

## [0.17.0] - 2026-09-22

### Added
- Added per-user appearance preferences with a background image upload that checks the bytes and refuses SVG, served owner-only and immutable
- Added a background option to send, which answers 202 after the cheap checks and relays from a bounded in-process queue with retries and crash recovery, publishes send-succeeded, send-retrying and send-failed, and treats a permanent failure as final on the first attempt
- Added stages, progress, timestamps, a check-now endpoint and a current-enrollment lookup to the signing certificate status, and fail an enrollment the CA never answers as order-expired
- Added provider-aware signing certificate status, so every enrollment names its backend (manual or rfc8823) instead of a client assuming automatic issuance, and a stale enrollment id now answers 404 signing-enrollment-unknown on status/check with an idempotent cancel, instead of a dead end
- Added BaseSigningEnrollmentAdminRoute at /admin/signing-enrollments, so a trusted administrator with an elevated token can list pending manual requests, download a request's CSR, upload and validate a certificate against it, or reject a request with a reason its owner sees
- Added CA health tracking to AcmeEnrollmentDriverJob, logging a failing run once instead of on every tick, auditing SIGNING_ENROLLMENT_CA_UNREACHABLE after repeated failures, and surfacing it through the new GET /system/signing-enrollment for any signed-in user

### Changed
- Test the access matrix for owner, delegate, unrelated user, elevated administrator and impersonation on MongoDB and SQL with a guard for new routes, principal resolution, well-known folders, the appearance and background send routes, the enrollment stages and a corpus of 127 hostile HTML payloads
- Document the changes in the README, the release notes and NOTES, including the route audit and the rollout
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Document the changes in the README, release notes and NOTES

### Fixed
- Fixed an administrator with an elevated token reading every user's mail, by allowing a mailbox's owner or an explicit ACL grant only, with the trusted roles stripped, in every mailbox-scoped route and in live push subscriptions, and add ?scope=admin, which needs an elevated trusted token, returns administrative metadata only and is audited
- Fixed a shared mailbox granted to a username matching nobody, by resolving what is typed to a user id through a mailbox address or the auth-server's aliases, rejecting anything unresolvable, flagging existing entries that have no effect and adding accessRole to a mailbox
- Fixed new accounts missing folders until a refresh, by creating all 11 well-known folders with the mailbox, healing missing ones on read and publishing a Folder create event for every creation, and fix a race that could create a second folder of the same type
- Fixed HTML mail losing all its styling and images, by replacing the default sanitizer with one that keeps allow-listed presentation, CSS and cid images and drops scripts, forms, frames, SVG and every URL that could run or leak, and re-sanitize stored mail from its raw source when it is opened
- Fixed encrypted messages between two mailboxes on the same deployment failing key discovery, by resolving a local address (primary, alias, or plus-tagged, case-insensitively) before ever attempting DNS federation, sharing one response builder with the public discovery endpoint so the two can never disagree

## [0.16.0] - 2026-09-21

### Added
- Added the message_folder_deleted_flags_read and message_folder_deleted indexes the count query uses

### Changed
- Refresh the stored counters where a message is ingested, imported, sent or a failure notice is filed, as a cache reads never trust, and keep bumping the folder's sync key
- Publish a Folder update event with the folder's uid, mailbox uid and both counts to the folder and mailbox channels after a message's folder, read flag, deletion or send changes, once per folder for a bulk change
- Test the counts across ingest, mark read and unread, bulk changes, move, archive, delete, restore, purge, send, drafts and wrong stored counters, and that listing folders costs a bounded number of queries
- Document the counts and the event in the README, the release notes and NOTES
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

### Fixed
- Fixed every folder's unreadCount and totalCount being wrong, by deriving them from the folder's messages with one grouped query per request on every folder read on MongoDB and SQL, since the stored counters were only ever incremented and showed 7 unread for an inbox with none, and correct a stale stored value on the read

## [0.15.0] - 2026-09-20

### Added
- Added per-recipient SMTP and transport diagnostics to TransportResult, and capture what sendmail printed and its exit status in PostfixSendmailTransport and the exception, status and request id in SesMailTransport, so a failed relay keeps the mail system's own reason
- Added DeliveryFailureNoticeUtils, which builds an RFC 3464 style delivery failure notice, and file one in the sender's Inbox, once, when a scheduled send is refused or given up on, or a transport refuses some recipients while relaying to others

### Changed
- Read each name from the alias field the auth-server returns rather than value or name
- Keep only the caller's own verified name aliases, so an elevated administrator's token can't be offered, or create a mailbox for, another user's username
- Fail a send that reached nobody with a 502 whose message is a plain sentence and whose details carry the per-recipient status codes and remote responses, and keep the message in Drafts
- Notify a local sender when the ingest drops their message for an unresolvable recipient, never for a null sender or an automatic message
- Preview a delivery status report by what it says, one entry per recipient, since the plain text preview cut the reason off after 500 characters
- Test the send failure, the notices and the bounces captured from a real Postfix (null envelope sender, expired and delayed) against real MongoDB and real SQL, and the alias lookup with a stub that answers only the real URL and response shape
- Document the changes in the README, the release notes and NOTES
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

### Fixed
- Fixed self-service mailbox creation never offering an address, by asking the auth-server for the caller's names at GET /api/aliases?type=name&userUid=me, which exists, instead of /api/aliases/me, which reads me as an alias uid and answers 404 for everyone
- Fixed a bounce listing no sender, by falling back to the From header when the envelope sender is null

## [0.14.0] - 2026-09-20

### Added
- Added the server's config values as defaults to the responses of GET and PUT /system/mailbox-policy, so an admin console can reset a field to what a newly deployed config says, since the policy is seeded from mail:default_quota_bytes and mail:auto_provision:* only the first time it is read and an administrator who had already saved it never saw a later change

### Changed
- Read defaults from the current config on every request rather than from the saved row, and leave resetting an ordinary audited PUT of the default value, so nothing about storage changes and there is nothing to migrate
- Export MailboxPolicyResponse from the package root
- Test defaults before anything is saved, after edits, and a reset by PUT against real MongoDB and real SQL
- Document the change in the release notes and NOTES, including why a reset writes the default rather than clearing the field to follow config live
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

## [0.13.0] - 2026-09-17

### Added
- Added BaseDirectoryRoute with DirectoryRouteMongo and DirectoryRouteSQL for compose recipient suggestions, mounted by the server at mail/directory
- Added GET /mail/directory, which searches the server's user, shared, room and equipment mailboxes and distribution lists by name word and address prefix, returning only display name, address and kind
- Added GET /mail/directory/contacts, which searches the contacts folders the caller can read in the mailboxes they own and in a readable mailboxUid
- Added util/RecipientUtils.ts with parseHeaderRecipients, buildDeliveredRecipients, parseSenderDisplayName, storedAddress, storedDisplayName and MAX_MESSAGE_RECIPIENTS, capping a message at 100 recipients, addresses at 320 characters, display names at 200, group nesting at five levels and refusing control characters, over the address lists mailparser has already parsed so a huge or hostile header adds no new parsing to the ingest path
- Added server-side sorting and filtering to the mail message list through named sortBy, sortOrder and filter query parameters on GET and HEAD /mail/messages, so a client's sort and filter menus are answered by the database over the whole folder instead of over the page it already fetched
- Added util/MessageListUtils.ts with the derivation, the sort and filter vocabularies and the paging bounds, exported from the package root
- Added listQueryParams and listQueryOverrides to BaseScopedChildRoute so a route can interpret its own query parameters and merge server-built filter fragments, including an $or a client can't send, over the stripped client query
- Added GET /mail/messages/conversations/:conversationId, returning one conversation's messages oldest first across every folder in the mailbox, paged and falling back to a uid lookup for a message that belongs to no thread
- Added label filtering to the mail message list through a comma-separated labelUids query parameter on GET and HEAD /mail/messages and on GET /mail/messages/conversations, returning the messages carrying any of the named labels - OR across the set, order-insensitive, ANDed with the existing filter, and applied by the database over the whole folder so limit and page stay correct under it

### Changed
- Refuse directory searches from callers who own no mailbox on the server unless they hold a trusted role, and leave out mailboxes with an approved or running erasure and deleted lists
- Match query text literally through escaped regular expressions on Mongo and escaped LIKE patterns on SQL, require 2 to 100 characters, cap limit at 20 and rate limit each endpoint to 120 requests a minute per caller
- Export parseDirectoryQuery, matchesDirectoryTerms, directoryNameWords, rankDirectoryEntries, escapeDirectoryRegExp, escapeDirectoryLike and the DIRECTORY limits
- Test both endpoints on Mongo and SQL, and the query helpers
- Document the routes in the release notes and NOTES
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Record everyone a delivered message was addressed to, building Message.recipients from the message's own To and Cc headers - and a Bcc header only when the delivered copy genuinely carries one - instead of the SMTP envelope, which named only the single mailbox each copy was filed into and left Reply All, conversation participants and every server-side reader with a one-entry list
- Keep an envelope recipient no header names - bcc'd, alias-only or expanded from a distribution list - as a bcc entry, deduped case-insensitively by address, so a copy still records the mailbox it was delivered into without putting a privately addressed recipient back on a visible header
- Store the sender's display name alone on from.displayName, unquoted and RFC 2047-decoded, instead of the whole From header, which a client rendered a second time after the address it also shows
- Keep from.address as the envelope sender, which the focused-inbox sender overrides and the search index are keyed on, and keep an address-like display name as the sender wrote it, which a client's phishing warning needs to see
- Expose headerRecipients and fromDisplayName on ScanPipelineResult, leaving parsedFrom as the whole From header value mail filter conditions match
- Apply the same recipients and display name fix to a mail filter rule's folder copy and to MailboxImportJob, which imported every message with no recipients at all
- Test both fixes on Mongo and SQL - multiple To and Cc recipients, display names with commas, quotes and encoded words, a bcc'd recipient absent from the headers, a malformed header and a 5000-address one - and unit test the new utility
- Document the fixes in the release notes and NOTES
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Sort by date, sentDate, from, subject, importance or flagged, always with receivedDate and uid appended as tiebreakers so limit and page can't show a message twice or skip one, and refuse an unknown sortBy or sortOrder with a 400
- Filter by all, unread, read, flagged, hasAttachments, focused or other, with focused also matching a message carrying no inferenceClassification at all
- Store read, flagged, fromAddress and importanceRank as server-managed, indexed mirrors of flags, from and importance, since flags and from are one simple-json column on the SQL backend and nothing could filter or sort on a field inside them on both backends
- Derive the mirrors in the Message model constructors and re-derive them on every update patch, refuse them in a request body for every caller including a trusted one, and export deriveMessageListFields and syncMessageListFields for protocol packages that write flags themselves
- Index Message on folderUid and receivedDate, folderUid read and receivedDate, folderUid flagged and receivedDate, and mailboxUid conversationId and receivedDate, on both backends
- Accept folderUid, filter, limit and page on GET /mail/messages/conversations, scan newest first so the conversation cap drops the oldest messages rather than an arbitrary slice, and report flagged, latestMessageUid, latestFrom, latestPreview and latestFolderUid for a collapsed conversation row
- Break a receivedDate tie in a conversation summary by uid, so which message the summary calls latest no longer depends on the order the database happened to return them in
- Bound a bulk PUT on any scoped child collection at MAX_BULK_UPDATE objects, and document its fail-fast, non-atomic semantics as what a mail client's multi-select bulk actions should use
- Test every sort key, every filter, paging stability, mirror derivation and body rejection, conversation folder scoping, filtering, paging, tie-breaking and expansion, and the bulk cap, against real Mongo and real SQL
- Document the new parameters, fields, indexes and the absence of a backfill in the release notes and NOTES
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Apply it to a conversation list's messages before they are grouped, exactly where filter is already applied, so a conversation appears when any of its messages carries any of the labels and reports only those messages
- Match labelUids where it is already stored rather than adding another denormalized mirror: array membership on MongoDB, and one LIKE per uid against the stored simple-json text on SQL, each matching the uid with its JSON quotes so one uid can never match a substring of another
- Keep that decision deliberate - a mirror column would hide every already-labelled message until it was backfilled, would go stale for any writer that sets labelUids outside this library's update path, and would buy no index anyway, since a leading-wildcard LIKE can use none either way and the list is already narrowed to one folder first
- Build the predicate per backend through a new abstract buildLabelUidsFilter on BaseMessageRoute, implemented by MessageRouteMongo and MessageRouteSQL over buildMessageLabelFilterMongo and buildMessageLabelFilterSQL, since the same query DSL expression means different things against an array and against JSON text
- Validate every entry as a uid instead of escaping it, which by construction excludes the LIKE wildcards, the quote that would break out of the JSON string and the characters the op(value) DSL reads as syntax, and refuse a malformed entry with a 400 rather than answering with a query that matches nothing
- Cap a request at MAX_MESSAGE_LABEL_FILTER_UIDS labels with a 400, treat an absent or empty value as no filter, refuse an empty entry inside a list, and read a repeated labelUids parameter as one set
- Interpret labelUids in the route now instead of letting it fall through to the generic query DSL, where it matched a single label by array membership on MongoDB and nothing at all on SQL
- Export parseMessageLabelUids, buildMessageLabelFilterMongo, buildMessageLabelFilterSQL and MAX_MESSAGE_LABEL_FILTER_UIDS from the package root
- Test the filter against real Mongo and real SQL - one label, several ORed in either order, combined with a named filter and a sort, the HEAD count, paging stability, an unknown uid, another mailbox's uid, a legacy row carrying no labels, a uid differing only in its last character, an empty and a repeated parameter, a malformed uid, the cap, and the conversation endpoint - and unit test the parsing and both predicates
- Document the parameter, its OR semantics and the absence of any migration in the release notes and NOTES
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Write a reply's In-Reply-To and References headers into the MIME POST /mail/messages/:id/send relays, from the inReplyTo and references the draft records, since this server composes a reply's source from the recipients, subject and HTML a compose client sends and nothing in it named the message being replied to - so every recipient's ingest pipeline, and the sender's own Sent Items copy, filed a reply as a brand-new conversation and a mail list in conversation mode showed one row per message of a thread, each reporting one message
- Persist those bytes as the message's stored body before the send is claimed, so a scheduled send relays exactly what an immediate one would and a client reading the raw source sees the thread
- Leave MIME that already carries either header exactly as it is, including a signed or encrypted body assembled client-side through assemble-raw
- Build the relayed References as the draft's chain with the replied-to message appended, trimmed from after the thread's root to MAX_RELAYED_REFERENCES entries and MAX_RELAYED_REFERENCES_LENGTH characters, since a chain grows by one entry per reply forever and a header line may not exceed 998
- Resolve Message.conversationId against the mailbox instead of from a message's own headers alone, on delivery and on send alike - join the conversation an ancestor named in References or In-Reply-To is already filed under, and fall back to the header derivation only when the mailbox holds none of them
- Keep a message that replies to nothing in its own conversation, and never thread by subject, so a subject change mid-thread holds the conversation together and a new message sharing a thread's subject never joins it
- Look the ancestors up in one indexed messageId IN query of at most MAX_CONVERSATION_ANCESTORS ids, nearest ancestor first, which is what holds a chain deeper than one reply together when a client sets only In-Reply-To
- Record on the sent copy the In-Reply-To and References the relayed bytes actually carry, rather than only what the draft row said
- Raise the recipient-suggestion limit from 120 to 600 requests a minute per caller on GET /mail/directory and GET /mail/directory/contacts, and the address lookup from 30 to 300 a minute on GET /mail/mailboxes/lookup-by-email, because a recipient field asks both directory endpoints on every pause in typing and reached the old limit in about twenty seconds of ordinary composing, after which every further request was refused for the rest of the minute and the suggestions silently stopped
- Document on both constants that an explicit limit is what interactive use runs into, since a deployment's authenticated rate-limit tier is applied under it rather than over it
- Test the threading on delivery and on send against real MongoDB and real SQL - a two- and a three-deep chain, a reply carrying References but no In-Reply-To, a reply naming only its direct parent, a message with neither header, a subject change mid-thread, a reply whose ancestors the mailbox has never seen, a scheduled reply, and the conversation list reporting every message exactly once rather than a group alongside its own members
- Document the fix, what a compose client must now send on a reply draft, and the new rate limits in the release notes and NOTES
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

## [0.12.0] - 2026-09-15

### Added
- Added an optional ui field to plugin manifests declaring pages on the public, www, admin or escrow hosts and navigation entries for settings, the admin console and the app rail, validated when a plugin is looked up

### Changed
- Refuse plugin pages at reserved core paths, and refuse plugin changes whose pages would share or nest under another enabled plugin's pages, including changes made at the same time
- Export PluginUiUtils with the manifest ui parser, the reserved mount list and the mount conflict helpers for the server
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Export DateCoercionUtils from the package root for plugins
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

### Removed
- Removed public booking pages, booking types and bookings from core, moving them to @rapidmx/booking-plugin; resource and room booking stay
- Removed the booking class fields and purges from the erasure job, leaving bookings to the generic mailbox-scoped plugin data purge

## [0.11.0] - 2026-09-15

### Added
- Added POST /mail/mailboxes/:id/keys/trust, which pins a validated signing certificate for a sender that has no pinned signing key, refusing a different pinned key with 409 and auditing each pin
- Added POST /mail/mailboxes/:id/keys/resolve to accept or reject a key conflict against the pinned fingerprint the user saw, auditing each decision
- Added PUT /mail/messages/:id/verification-seal for client-written verification seals, set once per master key generation and replaceable only after a rekey

### Changed
- Share one version-checked, race-retrying contact key write between key lookup, trust and ScanQueueJob so concurrent writers end with one contact and one signing key
- Create the Contacts folder without granting the caller creator rights, and query contact emails literally
- Require auditLogClass on BaseKeyLookupRoute subclasses, and note the endpoint and breaking change in the unreleased release notes
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Store and publish each key's verified issuer certificate from the local CA, OpenBao, ACME and manual certificate chains
- Mark keys superseded by a newer key of the same use as revoked with revocationReason superseded, and keep rekey from clearing or weakening revocations
- Replace a contact's pinned key automatically when the new and pinned certificates verify against the same issuer and the pinned key is expired or revoked, keeping the old key in previousKeys
- Record one key conflict per use type with the full observed key, remember rejected keys, and refresh discovery when a key header conflicts
- Replace Contact.keyConflict with keyConflicts, previousKeys and rejectedKeys, and document the rules in the spec and release notes
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Store verificationSeal and verificationSealGeneration as server-managed message fields that no other write or message copy sets, and include them in data and matter exports
- Require keyVaultClass on BaseMessageRoute subclasses
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

## [0.10.0] - 2026-09-15

### Added
- Added plugin registry search at GET /plugins/search, which finds packages named *-plugin in one or every configured namespace and reports each one's latest version, whether it's allowed, whether it's installed and whether an update is available
- Added GET /plugins/updates, reporting each installed plugin's latest published version and whether it's newer than the installed one
- Added system:plugins:namespaces, a list of npm scopes to search for plugins, each optionally with its own registry and token; packages in a configured namespace are allowed to be added, and are looked up on that namespace's registry
- Added GET /plugins/namespaces, listing the configured namespaces without their tokens
- Added NpmRegistryClient.searchPlugins(), normalizePluginNamespaces(), findPluginNamespace() and isNewerVersion()
- Added requires to the plugin manifest, mapping other plugin packages to the semver ranges a plugin needs, validated by parsePluginManifest
- Added PluginDependencies with planPluginChange(), which installs missing requirements at the highest version in range (dependencies first) and enables disabled ones, refusing out-of-range installs, missing versions, disallowed packages, cycles and version changes that break an enabled dependent
- Added findDependents(), orderByDependencies() and pruneUnmetRequirements() for the server host's load order
- Added GET /plugins/plan, previewing what adding or changing a plugin also installs and enables
- Added semver as a dependency
- Added timeouts, size limits and per-client caching to registry requests, reject non-semver resolved versions, and skip search results without a version
- Added GET /mail/mailboxes/:id/access/me with the caller's effective read, create, update, delete and manage access
- Added clearing a retention period with null
- Added forwarding loop protection with envelope rewriting, per-occurrence reminder claims, HMAC escrow audit chaining with a head record, deterministic well-known folder ids, text SQL columns and missing indexes

### Changed
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Install and enable requirements when adding a plugin, returning { plugin, dependencies } from POST /plugins
- Plan requirements when enabling a plugin or changing its version, and block disabling or uninstalling a plugin that an enabled plugin requires, with a 409 naming the dependents
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Require authentication and a single plain address for mailbox lookup-by-email, querying it literally so search operators like like() or in() can't enumerate owners, and rate limit it
- Only grant mailbox access to user uids, refusing anonymous, wildcard and role ids, and require full access to grant, change or remove a manager or to change your own access
- Audit mailbox access grants and revocations, report other action sets as a custom role with their actions, read the ACL uncached before changing it, and return 409 on a concurrent change
- Store mailbox and mailbox policy quotas as doubles so 5GB+ values fit on Postgres and MySQL, require safe-integer quotas, fail self-service mailbox creation closed when the policy can't be read, and require authentication to read the policy
- Keep saving a setup step from making setup required again once it's complete, and retry concurrent step saves
- Hold data-subject erasure while an installed plugin isn't loaded, so its mailbox-scoped data isn't skipped
- Accept system:plugins:allowed_packages and namespaces as JSON or comma-separated strings, dropping unscoped wildcards and malformed entries
- Validate plugin package names against npm's rules, encode them in registry requests and refuse a registry response for a different package
- Undo a plugin change's dependency writes when it fails partway, refuse to overwrite a plugin row created while planning, check the allow-list when enabling or changing version, and report updates for disallowed plugins as unavailable
- Accept expectedPlan on POST and PUT /system/plugins, refusing with 409 when the dependencies to install or enable differ from the previewed plan
- Validate plugin setting defaults, select options, duplicate and reserved keys, and look up requirements by own keys only
- Update package names in docs to the -plugin names
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Use double precision for SQL quota and timestamp columns, which Postgres rejected as double, and document the manual ALTER needed before upgrading existing Postgres and MySQL databases
- Refuse changes to a mailbox's owner, quota or used bytes from non-trusted callers, require UUID owner uids, and lowercase mailbox addresses
- Apply the mailbox policy to non-trusted POST /mailboxes: self-service must be enabled, addresses must be the caller's own on verified domains, and the quota is the policy's
- Require full access when any other ACL record could give a member full access, check access against the same uncached ACL that is saved, store member uids lowercase, look up owners case-insensitively, and limit lookup-by-email to 30 per minute
- Hold erasure only for unloaded plugins whose manifest declares mailboxScopedData, and log the data a removed plugin leaves behind
- Check the allow-list for disabled dependencies being enabled, include the target version in expectedPlan, plan installed plugins from their stored manifest, and ignore expectedPlan when a change leaves a plugin disabled
- Delete rows a failed plugin change created instead of soft-removing them, undo PUT and DELETE writes too, and refuse with 409 and undo when a concurrent change leaves an enabled plugin's requirement unmet
- Treat dependencies with unset required settings as conflicts, reject empty or non-exact versions and repeated query values, and only report search updates for allowed packages
- Use a namespace's own token on the default registry, send registry URL credentials as a Basic header without echoing them in errors, and keep announce failures from replacing a change's result
- Include integrity in the plugin state hash
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Generate every create route's uid on the server so a client can't claim an existing ACL, strip $ keys and forced scope keys from client queries, and require real unexpired share links resolved as share:<token>
- Block client writes to blob keys, server-controlled message, attachment and folder fields, ingest queue and quarantine rows, and dates on delivered mail, and send read receipts at most once
- Validate alias changes, refuse re-creating addresses with leftover data, keep filter rule targets in the rule's mailbox, require From to be a mailbox address when sending or recalling, and serve attachments and message content with safe types, nosniff and CSP
- Search a delegated mailbox by mailboxUid, count label and types as search filters, and normalize Focused Inbox overrides
- Validate booking manage tokens, tie booking types to their mailbox's calendar folders, page busy time, and rate limit anonymous booking per IP and slug
- Guard audit, escrow audit, escrow scope and domain rows against bulk and property updates, stop admins becoming escrow holders, expire approved escrow access and refuse it for closed matters or removed custodians
- Make key vault writes owner-only and refuse removing the last unlock wrap, allow only raster branding uploads with sanitized header and footer HTML, coerce calendar and matter dates, and page request lists newest first
- Count shared blob references before deleting, purge key vaults and share links on erasure, and retry inbound mail with leases, backoff and idempotent delivery ids
- Only send invites from organizer mailboxes, require DKIM-aligned senders for iTIP, recall and ACME mail, stop scheduled sends resending after relay, and page past held or failing items in job queues
- Isolate search indexing failures per document, fix Mongo participant search, write PKI files atomically, include the domain in key discovery, and stop auto-replacing pinned keys
- Expand recurrences near the query window with ordinal BYDAY, DST-correct stepping and Windows zone names, stream mbox exports, budget PST imports, and skip scanner errors on import
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Strip client _id, version, dates and dotted or $ keys on create, and reject dotted or $ keys on update, bulk update and property routes
- Check stored From/Sender headers before any send, schedule only through POST /:id/send, and claim immediate sends with a version-checked move into Outbox
- Block moving legally held messages to another mailbox, keep the mailbox owner's ACL record in step with owner changes, and require delete and update rights for ?deleted=true
- Recompute hasAttachments server-side, coerce date fields on create and update, and require aligned DKIM before honouring list unsubscribe
- Generate Matter and EscrowScope uids server-side, version-check key vault, booking and plugin updates on Mongo, and validate rekey requests
- Bound booking types, windows, overrides and slot generation, rate-limit slot lookups per client IP, and version-check cancel and reschedule
- Return 409 for downloads from closed matters and compare escrow public keys by their fields
- Trust RapidMX-Key and recall headers only when oversigned by aligned verified DKIM
- Count ScanQueueJob attempts at claim, renew leases, park exhausted entries, and send delivery receipts exactly once after filing
- Forward before forward-and-delete returns, drop mail for mailboxes under erasure, bound resource conflict checks, and ignore stale meeting replies
- Claim and lease erasure, matter export and scheduled send jobs, page purges by keyset, and include soft-deleted mail in retention
- Bound indexed string lookups with hashes, add compound indexes and SQL column types, and purge search index entries for deleted mail
- Isolate content extraction in worker threads with zip bomb limits, chunk OpenSearch bulk requests by bytes, and write local blobs atomically
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Mark in-flight sends with a lease, refuse moving a message out of Outbox while its send is in flight, and file into Sent Items only while the claim still holds
- Require at least one recipient to send, persist the relayed marker in its own write, and bound messageId, conversationId and icalUid on every patch write
- Refuse non-trusted moves into Drafts except from Outbox or Drafts, so sent or received mail can't be rewritten through compose
- Defer instead of dropping mail for approved or hold-blocked erasures, ignore erasure requests older than the mailbox, and bound the deferral
- Rewrite unauthenticated From and strip trust headers and calendar parts when relaying through distribution lists or forward rules, and require DKIM-verified members for restricted lists
- Apply the address-like display name rule to the lexer's parsed From and Sender, also at scheduled send time, and trust only the topmost Authentication-Results
- Claim delivery receipts before sending and track auto-replies per ingest entry, and expand resource bookings in windows so long open-ended series aren't declined
- Limit owner renames of the primary address to their own usernames, move owner ACL grants before the owner field, and reject display names containing @ or line breaks
- Scope attachment listing and access by the owning message's current folder
- Refuse rekey while a sign enrollment holds a wrapped key, let owners cancel enrollments, track master key generations, replace escrow wraps on rekey, and bind enrollment ids to their mailbox
- Return 409 when first-time enrollment wraps are sent to an already initialized vault, key IPv6 booking rate limits by /64, and export asEntity, legal hold helpers and findPagesByUid
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Updated @rapidrest/service-core to ^2.1.0 as both the dev dependency and the peer range
- Pass allowExistingACL when creating well-known folders at their deterministic uids, resetting any leftover ACL there to the mailbox with no records
- Recognise service-core's IDENTIFIER_EXISTS 400 as a duplicate key so lost create races still re-read the winner
- Use ModelUtils.literal() for sender- and client-controlled lookups, including values that were previously unescaped in mail ingest, ScanQueueJob and MailboxImportJob
- Truncate scoped children, mailboxes and matters with literal in() lists in bounded batches instead of one eq() per uid
- Document which framework workarounds service-core 2.1.0 makes redundant
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Require non-trusted sends to come from Drafts, refuse deleting a message whose send is in flight, and refuse moving delivered mail from Outbox to Drafts
- Drop mail for erased mailboxes whose row is gone instead of eventually delivering it, and check erasure before scanning
- Mark relayed immediate sends so ScheduledSendJob finishes filing after a crash, and re-read soft-deleted rows when recording the relay
- Send meeting invites from the organizer mailbox's safe display name, skip non-plain attendees, refuse more than 500 and pass invites through the scan pipeline
- Validate calendar organizer and attendee addresses on REST writes, and use safe display names in booking, receipt, recall and auto-reply mail
- Keep well-known folders' ACLs after concurrent creation races, and reset leftover ACLs without wiping grants made meanwhile
- Page attachment truncate realignment by uid so moved-message attachments aren't skipped and deleted
- Undo overlapping owner ACL moves newest first and only when unchanged, and refuse look-alike @ in mailbox display names
- Accept expectedMasterKeyGeneration on key vault writes with 409 on mismatch, and refuse deleting escrow scopes still assigned to mailboxes
- Track superseded draft bodies kept under legal hold on the message, export them with matters and release them after the hold
- Parse client dates as ISO 8601 with UTC default or epoch milliseconds only
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

## [0.9.0] - 2026-09-14

### Added
- Added mailbox access management + email-lookup routes for shared mailboxes
- Added a plugin contract: the rapidmx.plugin manifest, PLUGIN_API_VERSION, settings validation, the package allow-list matcher and a state hash every server copy compares against
- Added a Plugin model (Mongo/SQL) recording each plugin's package version, integrity hash, enabled flag, settings and manifest snapshot, kept as a removed row rather than deleted so default plugins never re-add one an administrator removed
- Added BasePluginRoute (trusted-role only) to preview a package from the npm registry, add, upgrade, configure, enable, disable and remove plugins, and read each server copy's reported status, announcing every change on the plugins Redis channel
- Added NpmRegistryClient for reading package versions and manifests from a configurable, optionally authenticated registry
- Added PluginRegistry, the loaded-plugin list a host sets and plugins read, and the @MailboxScopedData() decorator
- Added tests for the mailbox access route's unknown-mailbox, missing-ACL and missing-email paths and its SQL alias query
- Added notes on the plugin contract, soft-removed plugin rows, PluginRegistry's design and the erasure hook
- Added a MailboxPolicy singleton at system/mailbox-policy for the default mailbox quota and self-service mailbox creation, seeded from the mail:default_quota_bytes and mail:auto_provision:* config on first use and falling back to that config for unset fields or a failed read
- Added a SetupState singleton at system/setup that tracks the first-run setup wizard: whether setup is required (never started on a server with domains, or started and not finished), the current step, completion and reopening
- Added findOrCreateSingleton() for create-or-fetch of singleton settings rows

### Changed
- BaseMailboxAccessRoute (mongo/sql) is a thin, purpose-built wrapper around a
- mailbox's own AccessControlList - list/grant/revoke a delegate's access via a
- simple viewer/manager vocabulary, gated at plain ACLAction.UPDATE rather than
- the literal FULL the generic BaseACLRoute requires, so a non-owner delegate
- can manage membership too. A single grant here already cascades to every
- folder and record under the mailbox (confirmed via research: parentUid
- chaining already wires every well-known folder's ACL to its mailbox, and
- CalendarEvent/Contact/Task/Message have no independent ACL of their own).
- Also adds GET /mail/mailboxes/lookup-by-email, resolving an email to the
- person who owns the Mailbox at that address (primarySmtpAddress or an alias)
- - there is no separate user/identity directory anywhere in this platform, so
- this is the only way to turn "someone's email" into a uid for a share-access
- UI. Deliberately excludes shared/ownerless mailboxes from matching.
- First piece of a larger shared-mailbox feature (booking pages already work
- for shared mailboxes with no changes needed; multi-mailbox Mail/Calendar UI
- is a separate follow-up pass).
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Test that a shared mailbox's delegate can create a booking link
- Covers the shared-mailbox booking page case end to end at the route level:
- a manager-role delegate on an ownerless mailbox can create a booking type
- for it, and a viewer-role delegate gets 403. No route change was needed -
- BookingType is already permission-checked against the mailbox's ACL.
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Move DeviceSyncState and EasDeviceStateCleanupJob out of this library and into the ActiveSync plugin
- Change ErasureExecutionJob to purge every loaded @MailboxScopedData() model in its datastore instead of DeviceSyncState specifically, so plugin data is still erased with its mailbox
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Rename the plugin config keys from plugins:* to system:plugins:*, grouping deployment-wide settings under system
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Change autoProvision() to read the mailbox policy instead of the auto-provision config directly
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Updated the release notes for the plugin contract, shared mailbox access, mailbox policy and setup state changes
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

### Fixed
- Fixed test isolation for suites that rely on auto-provisioning config now that the policy row it seeds persists across test files

## [0.8.0] - 2026-09-13

### Added
- Added findAllPages() row capping to DataExportJob.buildMboxBundle(), which previously had no size cap at all unlike its JSON sibling
- Added tests for the claim-before-relay race, the restore-on-failure path, and the double-failure (restore also fails) path, plus an mbox-format max_content_rows cap test mirroring the existing JSON one

### Changed
- Restore scheduledSendTime (best-effort, re-fetching first) when the relay fails after a successful claim, preserving this job's own documented leave-it-for-retry behavior on failure
- Investigate MatterExportJob's per-custodian-only cap and confirm it is a deliberate, already-documented design decision, not a gap - leave it unchanged
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

### Fixed
- Fixed a critical send-after-cancel race in ScheduledSendJob: relayDueMessage() now claims the message via a version-checked clear of scheduledSendTime before calling scanAndRelay(), the same claim-first-work-second discipline DataExportJob/MailboxImportJob already use
- Fixed this repo's own broken lint gate: auto-fix six unnecessary-type-assertion errors via eslint --fix, manually fix two empty-function stubs in PstImportUtils.test.ts by giving them a real, harmless body matching their actual signature

## [0.7.0] - 2026-09-12

### Added
- Added Label entity (LabelSQL/LabelMongo) with mailbox-scoped CRUD routes
- Added Message.labelUids to reference applied labels by uid
- Added cascade cleanup removing a deleted label's uid from every referencing message
- Added MailFilterActionType.APPLY_LABEL mail filter action
- Added label: search operator to SearchProvider, BaseSearchRoute, and all three search providers
- Added S3BlobStore, an S3/S3-compatible BlobStore backend
- Added FolderType.ARCHIVE and its default display name
- Added a POST /:id/archive action on BaseMessageRoute, mirroring recall()'s shape
- Added EscrowScope entity with admin-only CRUD (holders, dual-control threshold, notify flag)
- Added Mailbox.escrowScopeId assignment, restricted to a trusted administrator
- Added BaseKeyVaultRoute.resolveAllowEscrow(), the prerequisite for a real escrow-method MasterKeyWrap
- Added Matter entity, holder-gated CRUD rather than admin-gated (separation of duties)
- Added EscrowUtils.requireEscrowHolder()/findHeldScopeIds(), shared holder-check helpers
- Added hash-chained EscrowAuditLogEntry, tamper-evident against direct DB edits
- Added EscrowAuditUtils.recordEscrowAuditEntry()/verifyEscrowAuditChain()
- Added read-only BaseEscrowAuditLogRoute, holder-scoped or unfiltered for a trusted admin
- Added EscrowAccessRequest dual-control workflow for escrow key material access
- Added create/approve/deny/material endpoints gated by EscrowScope holder status and M-of-N approval thresholds
- Added hash-chained escrow audit entries recorded atomically alongside every create/approve/material-read action
- Added a 409 guard blocking Matter deletion while EscrowAccessRequests still reference it
- Added coverage for pre-existing untested branches in BaseMatterRoute (not-found guards, bulk create, validation-skip paths)
- Added Rfc8823AcmeSigningCertificateEnrollment (F4b sub-item 1 of 4)
- Added real RFC 8823 email-reply-00 ACME automation via the acme-client package, driven through its manual API since email-reply-00 has no native support
- Added persisted ACME account key/URL and per-enrollment state, mirroring the existing local-CA disk-persistence pattern
- Added recordChallengeToken() as the seam a later inbound-mail correlator will call once the CA's challenge email arrives
- Added inbound RFC 8823 challenge-email correlation (F4b sub-item 2 of 4)
- Added ScanQueueJob.tryCorrelateAcmeChallenge(), recognizing a CA challenge email by its Auto-Submitted/Subject shape and matching it against an outstanding enrollment before ever treating it as CA plumbing
- Added ScanPipelineResult.replyToAddress, needed to address the eventual reply per RFC 8823's own Reply-To-else-From rule
- Added Rfc8823AcmeSigningCertificateEnrollment.findPendingEnrollmentId(), the reverse lookup the correlator needs since nothing in the challenge email itself carries this server's own enrollmentId
- Added outbound RFC 8823 reply and challenge-completion pipeline (F4b sub-item 3 of 4)
- Added Rfc8823AcmeSigningCertificateEnrollment.advanceEnrollment(), a single non-blocking state-machine step per call: send the reply email and complete the challenge, then poll/finalize/download the certificate once the CA validates it
- Added sendChallengeReply(), composing the exact RFC 8823 reply shape (Re:-prefixed subject, In-Reply-To, the BEGIN/END ACME RESPONSE body block) and relaying it via the same scanAndRelay() path every other real outbound message uses
- Added MailTransport/ScanPipeline/BlobStore injection to Rfc8823AcmeSigningCertificateEnrollment, needed to actually send that reply
- Added sign-enrollment REST endpoints and the ACME driver job (F4b sub-item 4 of 4)
- Added BaseKeyVaultRoute.startSignEnrollment()/checkSignEnrollmentStatus(), accepting the wrapped private key upfront alongside the CSR so the eventual install needs no further client action
- Added AcmeEnrollmentDriverJob, advancing every outstanding RFC 8823 enrollment and auto-installing the certificate into the mailbox's KeyVault once the CA issues it, idempotently via a fingerprint-collision guard
- Added AcmeEnrollmentDriverJob's expiry-check pass, flagging a mailbox's signing certificate nearing notAfter with nothing newer already enrolled
- Added Rfc8823AcmeSigningCertificateEnrollment.attachWrappedKey()/listPendingEnrollments()/getIssuedMaterial()/markInstalled(), the seams the job and route need
- Added model constructor partial-data tests closing !== undefined ternary false-branch gaps in Booking/FocusedInboxOverride/EscrowAccessRequest/Branding (SQL+Mongo)
- Added direct-call tests for BaseAuditLogRoute/BaseEscrowAuditLogRoute's rejectWrite()-guarded bodies, dead via HTTP since @Before intercepts before the handler runs
- Added real count()/findById() holder-scoping tests for BaseEscrowAuditLogRoute, previously only exercised via find()
- Added unit tests for BaseBrandingRoute's SSR-only readPublicBranding()/fetchBrandingPropsForSSR() helpers
- Added shared.ts's AWS SDK dynamic-import failure-path tests via vi.doMock
- Added PostgresFullTextSearchProvider's untested flags/before/after candidate filters
- Added BaseKeyVaultRoute's five MAX_*_EXCEEDED validation tests
- Added BaseSearchRoute's candidates() guard clause, requireCallerMailboxUid()'s !user guard, and before/after date-parsing tests
- Added verified-domain-on-rename tests for BaseMailboxRoute/BaseDistributionListRoute, and 404 tests for BaseEscrowScopeRoute's update()/delete()
- Added MailboxRouteSQL's %/_/\ ACL-role escaping test, a real wildcard-injection correctness check
- Added OpenBaoPkiCertificateAuthority's serialMapQueue self-recovery test after a write failure
- Added EscrowAuditUtils's broken-previousHash chain-detection test, distinct from a per-entry hash mismatch
- Added BaseMessageRoute.archive()'s missing guard-clause test
- Added SearchIndexJob's answered/forwarded flag coverage
- Added BaseDomainRoute's best-effort DKIM-backfill-failure test
- Added Legal Hold enforcement, extending Matter (compliance roadmap Group A)
- Added util/LegalHoldUtils.ts's findActiveHoldsFor()/assertNotOnLegalHold() - an open Matter's custodianMailboxUids/dateRangeStart/dateRangeEnd/closedAt already describe a litigation hold, just not wired to block anything until now
- Added BaseScopedChildRoute.checkLegalHold() hook (no-op default, purge-only) so a permanent delete of a held record is blocked while an ordinary soft-delete stays unaffected
- Added BaseMailboxRoute's first delete() override (Mailbox has no soft-delete of its own) blocking a whole-mailbox delete against any open hold regardless of date range
- Added AuditAction.LEGAL_HOLD_BLOCKED_DELETE, recorded whenever a hold actually blocks a destructive attempt
- Added util/AuditLogUtils.isNonOwnerAccess() - true when the caller isn't the mailbox's own owner (an admin reaching in via a trusted-role grant, or a delegate), the one signal distinguishing a compliance-relevant access from a user's own ordinary, unaudited activity
- Added AuditAction.MESSAGE_CONTENT_ACCESSED, recorded on GET /messages/:id/content only for a non-owner read
- Added AuditAction.MAILBOX_ACCESSED via a new BaseMailboxRoute.findById() override, recorded only for a non-owner mailbox profile view
- Added configurable data-retention engine, legal-hold-aware (compliance roadmap Group C)
- Added RetentionPolicy singleton settings entity + BaseRetentionPolicyRoute, modeled directly on BaseEncryptionPolicyRoute/BaseBrandingRoute - GET open to any authenticated user, PUT trusted-role-only, every field unset by default (no automatic purge configured until an admin opts in)
- Added MIN_AUDIT_LOG_RETENTION_DAYS floor (2190 days / 6 years) - auditLogRetentionDays cannot be configured below it, approximating HIPAA's typical audit-trail retention expectation
- Added RetentionEnforcementJob (cron, mirrors QuarantineRetentionJob's single-page-per-run shape) enforcing messageRetentionDays/auditLogRetentionDays - a Message purge checks LegalHoldUtils.assertNotOnLegalHold() first and skips (not errors) a held record, naturally retried once its Matter closes
- Added GDPR data export (JSON + Mbox), self-service and admin-mediated (compliance roadmap Group D1)
- Added DataExportRequest entity + BaseDataExportRoute (bespoke, same shape as BaseEscrowAccessRequestRoute) - create() is both the self-service and admin-mediated endpoint, mirroring BaseMailboxRoute.create()'s "trusted caller may act for someone else, an ordinary caller's own identity always wins" idiom for mailboxUid
- Added util/MboxUtils.ts's buildMboxEntry()/parseMbox() - a real, interoperable mailbox export (Thunderbird/Apple Mail/Gmail Takeout all read it), hand-rolled since Mbox is a simple documented text format needing no dependency
- Added DataExportJob (cron) building either format: mbox concatenates each Message.bodyBlobKey's raw source; json aggregates every entity type that denormalizes mailboxUid (Mailbox/Message/Contact/ContactList/CalendarEvent/Task/Note/Attachment) as newline-delimited JSON
- Added mailbox import (Mbox + PST): Group D2
- Added GDPR right-to-erasure workflow: Group E
- Added eDiscovery enhancements (Matter export + search): Group F
- Added Unreleased section to RELEASE_NOTES.md

### Changed
- Wire APPLY_LABEL label application into ScanQueueJob's delivery and copy paths
- Document label: operator in specs/search.md
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Support custom endpoint and forcePathStyle for MinIO/R2/Spaces targets
- Support an optional key prefix for sharing one bucket across environments
- Support an explicit access key pair, falling back to the standard AWS credential chain
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Block archiving a message currently in Drafts or Outbox
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Guard the escrow-scope-assignment check against a harmless round-tripped SQL null
- Wire resolveAllowEscrow() into enrollKey()/addMasterKeyWrap(), leaving rekey() unchanged by design
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Block deleting an EscrowScope while a Matter still references it
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Restrict chain verification to a trusted admin, since the chain is global across scopes
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Extract BaseKeyVaultRoute's certificate-parsing/identity-binding logic into util/CertificateInstallUtils.ts, shared by the manual install path and the new automated one
- This completes the entire CASTLE/RFC 8823 automated signing-certificate enrollment feature (item 4 of the 4-item batch).
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Close the pre-existing coverage gap (100%/96.31%/100%/100% stmt/branch/fn/line)
- Mark 6 genuinely untestable/tool-quirk branches with justified /* v8 ignore */ comments (LocalX509CertificateAuthority and Rfc8823AcmeSigningCertificateEnrollment's TOCTOU retries, BaseMatterRoute/BaseEscrowScopeRoute's framework-shadowed name validation, S3BlobStore's v8-coverage-provider statement/branch miscount, MeetingSchedulingJob's query-shadowed status recheck)
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Override checkLegalHold() on BaseMessageRoute against its own mailboxUid/sentDate - the one entity a Matter's custodian list actually protects
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Audit non-owner access to mailbox content/profile (compliance roadmap Group B)
- An owner reading their own inbox/profile - the overwhelming majority of traffic - stays deliberately unaudited, matching this repo's existing audit-scope boundary
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Deliberately does NOT apply retention to EscrowAuditLogEntry - it's a hash-chained tamper-evident ledger where deleting any entry would break verifyEscrowAuditChain() for everything after it; permanent retention is by design, not an oversight
- Records one AuditAction.RETENTION_PURGE_EXECUTED summary entry per entity type per run (count, not one per record) to avoid flooding the audit trail
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Deliberately does NOT offer PST export - confirmed via research that no free/open Node library can write valid PST bytes, only paid SDKs; Mbox already satisfies the portability need without a new paid dependency
- GET /:id/download streams the finished bundle directly (BlobStore-backed), gated to the requester, the target mailbox's owner, or a trusted admin
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- MailboxImportRequest entity + BaseMailboxImportRoute (self/admin-mediated
- upload via req.rawBody, mirrors BaseDataExportRoute's create() idiom) and
- MailboxImportJob, completing the GDPR portability pair started by D1's export.
- Mbox import reuses D1's parseMbox(); PST import adds the free pst-extractor
- dependency and a new util/PstImportUtils.ts that reconstructs each PST mail
- item into a raw RFC 5322 buffer via nodemailer's MimeNode, so both formats
- feed the same ScanPipeline-based persistence step in MailboxImportJob (deliberately
- not ScanQueueJob.deliverMessage(), which is entangled with live-mail-only
- concerns). An infected attachment or message causes the whole item to be
- skipped and counted in failedCount, never partially imported.
- silently drops the From header for a non-address-shaped sender (common in
- older PST data), now synthesized into a valid address; and an optimistic-lock
- version mismatch that left a request stuck at "processing" forever if work
- failed after that status transition.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- DataSubjectErasureRequest + BaseDataSubjectErasureRequestRoute implements the
- create/approve/deny review workflow (mirrors BaseEscrowAccessRequestRoute's
- shape). create() is self-service only (no admin-on-behalf-of path, unlike the
- export/import routes) and rejects a duplicate pending request for the same
- mailbox. approve() checks LegalHoldUtils.assertNotOnLegalHold() synchronously
- (409 if held) and only transitions status to "approved" - the actual cascade
- is performed asynchronously by ErasureExecutionJob so a large mailbox can't
- time out the admin's request, the same instant-transition/async-job split
- already used for export and import.
- ErasureExecutionJob re-checks the legal hold immediately before cascading
- (skip and retry later if a hold appeared in the interim), then purges every
- mailboxUid-scoped entity plus Folder and the Mailbox row itself, explicitly
- deleting each row's own BlobStore content (message bodies, attachment blobs,
- contact photos) so no orphaned bytes survive the erasure. Every row purge is
- best-effort - one failure doesn't abort the rest of the cascade.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Group F closes the two remaining eDiscovery gaps beyond what Escrow Scoping
- already shipped, completing the HIPAA/GDPR/eDiscovery compliance roadmap
- (Groups A-F).
- MatterExportRequest + BaseMatterExportRequestRoute lets any holder of a
- Matter's EscrowScope (no dual-control approval needed, unlike
- EscrowAccessRequest - exporting at-rest content is a different risk than
- releasing key material) trigger an eDiscovery export spanning every
- custodian mailbox. MatterExportJob reuses DataExportJob's own aggregation
- step, now genuinely extracted into util/MailboxContentUtils.ts so both share
- it, narrowing only Message rows to the matter's date range. Each custodian
- mailbox actually exported is logged as its own hash-chained
- EscrowAuditLogEntry.
- BaseMatterSearchRoute adds holder-only full-text search across a Matter's
- custodian mailboxes, reusing the existing SearchProvider unchanged (one call
- per mailbox, keyed results, no merged cross-mailbox cursor invented) and
- always clamping before/after to the matter's own date range so a holder can
- never search outside the litigation hold's defined scope.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Two parallel adversarial agents (correctness/concurrency, security/perf)
- reviewed the full A-F diff; every finding was independently re-verified
- against source before fixing.
- - MboxUtils: parseMbox() truncated the last byte of every non-final
- message on round-trip, not just the last one.
- - MailboxImportJob: imported mail was stamped with import time instead
- of its real Date: header, silently breaking Legal Hold and Matter
- date-range narrowing for historical mail.
- - ErasureExecutionJob: cascade missed 13 of 25 mailboxUid-scoped entity
- types; added a final legal-hold re-check before the mailbox's own
- delete to close a TOCTOU window.
- - MailboxContentUtils/DataExportJob/MatterExportJob: unbounded
- in-memory aggregation now capped via a configurable max_content_rows.
- - PstImportUtils: Buffer.alloc(attachment.filesize) trusted an
- unverified PST property; now bounded against the PST file's own size.
- - MatterExportJob/BaseMatterSearchRoute: any escrow holder could list
- an arbitrary mailbox as a matter "custodian" and read/search its full
- content, bypassing the dual-control EscrowAccessRequest workflow -
- now requires the mailbox's own escrowScopeId to match the matter's,
- mirroring the check BaseEscrowAccessRequestRoute already enforced.
- Full suite: 205/205 files, 3237/3237 tests, 100%/96.37%/100%/100%.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Same two-agent methodology (correctness/concurrency, security/perf)
- run again after committing round one's fixes (1d4f713).
- - BaseScopedChildRoute/BaseMailboxRoute: Legal Hold was only wired
- into the singular delete() path under purge:true. The inherited
- bulk truncate() endpoint (DELETE /messages?folderUid=X, DELETE
- /mailboxes) is unconditionally a hard, permanent delete with no
- purge option at all, and had no hold check - a caller could destroy
- held records simply by using the bulk endpoint instead. Fixed by
- having truncate() check every matched record before deleting.
- - BaseMatterRoute: updateBulk/updateProperty/truncate were left
- un-overridden and fell through to the framework's generic ACL,
- which unconditionally grants any trusted-role (admin) caller access
- before consulting a record ACL - bypassing the holder-only
- separation-of-duties model this class exists to enforce, including
- truncate()'s ability to wipe every Matter (and thus every active
- legal hold) in one call. Fixed by overriding all three.
- - ErasureExecutionJob.markCompleted() refetched the request row
- immediately before its final update(), defeating its own optimistic
- lock against two job instances racing on the same request. Fixed by
- using the originally-fetched version, matching its sibling jobs.
- - MatterExportJob recorded a hash-chained escrow audit entry per
- mailbox inside the collection loop, before the export bundle was
- written/marked ready - a later custodian's failure left an earlier
- mailbox's entry permanently attesting to an export that never
- completed. Fixed by recording entries only after the bundle is
- ready. Applied the same escrowScopeId-match check (from round one)
- to BaseMatterExportRequestRoute.create()'s own audit loop.
- - RetentionEnforcementJob.purgeExpiredAuditLogEntries() had no
- legal-hold check, unlike its sibling purgeExpiredMessages() - a
- years-old investigation's own audit trail could be purged out from
- under it. Fixed with the identical per-entry hold check.
- - BaseDataExportRoute/BaseMailboxImportRoute find() only checked
- requestedByUserUid, so an admin-mediated request was invisible to
- the actual mailbox owner it was made for. Fixed to also include
- requests for mailboxes the caller owns.
- Full suite: 205/205 files, 3288/3288 tests, 100%/96.33%/100%/100%.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Round two's security agent had already named exists() alongside
- updateBulk/updateProperty/truncate as left un-overridden and thus
- falling through to the framework's generic ACL - I only fixed the
- other three. RepoUtils.exists() checks Matter's class-level ACL
- (deny-all, since holder-ness lives in EscrowScope.holderUserUids,
- not an ACL record) before any per-record check, and unconditionally
- bypasses that for a trusted role - letting a non-holder admin probe
- arbitrary matter uids for existence via HEAD /matters/:id.
- Mirrors findById()'s own holder check, translated into
- BaseScopedChildRoute.exists()'s found/not-found response shape
- (404 either way, so a non-holder can't distinguish "doesn't exist"
- from "exists, not yours").
- Full suite: 205/205 files, 3291/3291 tests, 100%/96.33%/100%/100%.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Same two-agent methodology, run again at the user's request after two
- prior rounds (1d4f713, 678b945, 723da84). Found real bugs even after
- an exhaustive per-method authorization sweep confirmed the "un-overridden
- CRUD method" bug class was otherwise closed:
- - BaseScopedChildRoute/BaseMatterRoute/BaseMailboxRoute: truncate()'s
- own round-2 fix checked a snapshot of matched records for legal-hold/
- reference violations, but then let the actual delete re-run the
- ORIGINAL query live via RepoUtils.truncate() - which re-executes its
- own search independently of that snapshot. A record matching the same
- filter that starts existing in the gap between the snapshot and the
- delete (e.g. mail delivered mid-request) would be deleted having
- never been checked at all. Fixed by re-scoping the actual delete to
- exactly the snapshotted/checked uids in all three copies.
- - RetentionEnforcementJob purged expired Messages but never their
- Attachment rows or either entity's own BlobStore content - PHI/PII a
- RetentionPolicy represents as deleted stayed fully stored and
- independently downloadable indefinitely, since Attachment has no
- DB-level cascade from Message (the same reason ErasureExecutionJob
- already treats this as an explicit step). Fixed with the identical
- cleanup that job already established.
- - MatterExportJob could get stuck at "ready" with a silently incomplete
- escrow audit trail: recordEscrowAuditEntry() genuinely throws after
- exhausting its own retry budget under real sequence contention, and
- that throw reached markFailed(), which tried to write a stale
- pre-"ready" version and failed silently - leaving an already-disclosed
- export with a permanently incomplete hash-chained ledger and no path
- to retry. Fixed by making the per-mailbox audit-recording loop
- best-effort (log loudly, continue) instead of re-entering the
- request's own state machine.
- - BaseDataSubjectErasureRequestRoute.create()'s pending-request check
- is a genuine TOCTOU (no transaction, and this codebase has no
- existing partial-unique-index precedent that wouldn't also block a
- legitimate resubmission after an earlier denial). Mitigated (narrowed,
- documented as not fully eliminated) via a post-create race check that
- auto-supersedes the losing side instead of leaving two pending rows.
- Full suite: 206/206 files, 3309/3309 tests, 100%/96.34%/100%/100%.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Fourth adversarial review round found and fixed:
- - LegalHoldUtils.findActiveHoldsFor() used a bare, unpaginated find() that
- silently truncates at the framework's 100-row default (confirmed against
- RepoUtils.js source) - once the global Matter table exceeds that count,
- assertNotOnLegalHold() (the choke point every irreversible-purge path
- depends on) could miss a real, active hold. Fixed with the same
- findAllPages()-style pagination already used elsewhere in this codebase.
- - Message/Attachment/Contact/CalendarEvent/Task/Note all let a client set an
- independent, unverified mailboxUid via create()/update(), completely
- divorced from the record's real folderUid-derived mailbox - none of these
- entities' scopeProperty is mailboxUid, so the existing re-parent permission
- check never fired on it. Every compliance job this roadmap shipped trusts
- mailboxUid as authoritative (ErasureExecutionJob, RetentionEnforcementJob,
- LegalHoldUtils), so this let a record silently evade or be wrongly swept
- into an erasure/retention-purge/legal-hold scoped to a mailbox it was never
- really in. Fixed at the root: BaseScopedChildRoute.resolveMailboxUidFor()
- now force-resolves mailboxUid from the actual target folder on every
- affected route, via a new util/FolderUtils.getMailboxUidForFolder() helper.
- - DataExportJob had no claim/processing state (unlike its sibling
- MailboxImportJob), so two overlapping runs could both build a bundle and
- race a non-transactional BlobStore.put() under the same deterministic key.
- - BaseMessageRoute.content() skipped its non-owner-access audit entirely
- when the message's mailbox couldn't be resolved (a dangling mailboxUid,
- e.g. after a mailbox delete with no cascade), even though content was
- still served. Fixed to audit defensively on unresolved ownership.
- - MailboxImportJob's folder-counter bump shared a try/catch with message
- persistence and the final "completed" write, so a benign version conflict
- there reported a fully-successful import as failed, inviting a duplicate
- re-run. Isolated it into its own try/catch.
- - MboxUtils.buildMboxEntry() interpolated fromAddress into the mbox
- separator line unsanitized, allowing an embedded CR/LF to inject a fake
- From separator and corrupt later re-parsing. Stripped CR/LF, matching the
- existing sanitizeFilename() convention.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

### Fixed
- Fixed two bugs surfaced by testing against a real PST fixture: MimeNode
- Fixed bugs found in adversarial review of compliance roadmap (Groups A-F)
- Fixed bugs found in second adversarial review round
- Fixed BaseMatterRoute.exists() bypassing separation of duties
- Fixed bugs found in third adversarial review round
- Fixed legal-hold pagination, mailboxUid integrity, and export/import races (round 4 adversarial review)
- Fixed with the same claim-then-work pattern MailboxImportJob already uses.

## [0.6.0] - 2026-09-11

### Added
- Added Mailbox.alwaysRequestReceiptFederated/autoSendReceiptsFederated (both default false, matching the existing External defaults) alongside the existing Internal/External settings, in both SQL and Mongo backends
- Added util/DomainUtils.ts's classifyRecipientTier(), built around an injectable isFederatedPeer seam that defaults to always-false until real _rapidmx federation discovery exists (a later roadmap item) - this keeps observable behavior identical to today's internal/external classification for now while giving BaseMessageRoute.send()/maybeSendReadReceipt() and ScanQueueJob.maybeSendDeliveryReceipt() a stable three-way switch to call into
- Added util/SmimeUtils.ts's isEncryptedBody() detecting application/pkcs7-mime; smime-type=enveloped-data and multipart/encrypted from an already-parsed message, excluding opaque S/MIME signing (smime-type=signed-data) which still carries real content
- Added ScanPipelineResult.encrypted and skip sanitizedHtml/bodyPreview derivation for an encrypted body; AV/spam scoring is unaffected since both already operate on the raw buffer
- Added federation discovery infrastructure (roadmap Group B): DNS policy resolution and the remote key-endpoint HTTP client, the shared groundwork both A5's real federated-peer detection and the eventual discovery-protocol routes build on
- Added util/FederationUtils.ts's resolveFederationPolicy(), resolving a domain's _rapidmx TXT record (v=RMXv1; id=...; host=...;), structurally mirroring DomainVerificationUtils.checkDomainVerification()'s never-throws/chunk-rejoin conventions, caching both positive and negative results via @rapidrest/core's SimpleStore (a plain MemoryStore, no new cache utility needed)
- Added util/KeyDiscoveryClient.ts's fetchRemoteKeys(), fetching a peer's GET /.well-known/rapidmx/keys/:hash endpoint and honoring ETag/Cache-Control/304 against its own separate SimpleStore instance, kept distinct from the DNS-policy cache per the spec's explicit separation of per-user key freshness from domain-policy caching; TLS certificate/hostname verification needs no extra code since Node's fetch() already refuses a certificate that doesn't chain to a trusted root or cover the hostname; includes a hand-rolled z-base32 encoder (computeKeyDiscoveryHash()) since no dependency exists for it and there is exactly one call site
- Added the shared PublicKey/EncryptionPreference/KeyDiscoveryResponse types to models/types.ts, pulled forward from the data-model group since the discovery client's return type needs them
- Added a compact nav-header icon to Branding, independent of the full logo
- Added util/DomainUtils.ts's createFederatedPeerCheck(dnsResolver), bridging classifyRecipientTier()'s FederatedPeerCheck seam to FederationUtils.resolveFederationPolicy() - a federated peer is any domain publishing a valid _rapidmx TXT record
- Added @Inject("DnsResolver") to BaseMessageRoute.ts and ScanQueueJob.ts (the same DI token BaseDomainRoute/DomainVerificationJob already register/consume, so every deployment and test environment already has one) and pass a real check into every classifyRecipientTier() call site instead of relying on the default stub
- Added real end-to-end tests (SQL + Mongo, both the send()-time request-attachment path and ScanQueueJob's delivery-receipt auto-send path) proving a federated peer registered via StaticDnsResolver actually activates the Federated tier, not just that the stub correctly does nothing - caught and fixed a genuine test-authoring bug in the process: envelopeTo in send() comes from Message.recipients (a structured field), not parsed from the raw MIME blob's own To: header, so both need to point at the test peer address
- Added CalendarEvent.encrypted provenance flag and wire it through ScanQueueJob's iTIP processing (roadmap items I2/I3 - Derived Entities inheritance)
- Added EncryptionPolicy singleton settings entity + route (roadmap Group H1) - the system-wide, per-recipient-tier encryption policy from specs/end-to-end_encryption.md's "Encryption Policy States" section
- Added EncryptionCertificateAuthority abstraction (F1-F3): pluggable internal-CA interface, mandatory NullEncryptionCertificateAuthority default, and LocalX509CertificateAuthority zero-infrastructure implementation
- Added OpenBaoPkiCertificateAuthority (F3b): recommended production EncryptionCertificateAuthority backend
- Added an optional IssuedCertificate.serialNumber field (populated by both LocalX509CertificateAuthority and this new adapter) - generic, useful X.509 metadata, additive to the interface introduced in the previous commit
- Added SigningCertificateEnrollment abstraction (F4): pluggable public-CA enrollment interface, mandatory Null default, and CA-agnostic ManualSigningCertificateEnrollment implementation
- Added Key/Keyring data model (Group C): WrappedPrivateKey/MasterKeyWrap/KeyVault types, Mailbox/Contact extensions, and a Contact write-protection fix
- Added WrappedPrivateKey and MasterKeyWrap (with an escrowScopeId seed field for the still-deferred Escrow Scoping follow-up) alongside the already-shipped PublicKey/EncryptionPreference types (C1)
- Added Mailbox.encryptPreference/keys (required, safe universal defaults) and keyDiscoveryHash (optional, deliberately NOT backfilled with a shared default under a uniqueness constraint - that would collide across every pre-existing row the moment a second one is saved, the same class of bug as this session's earlier alwaysRequestReceiptFederated NOT NULL incident); BaseMailboxRoute now computes/recomputes keyDiscoveryHash alongside primarySmtpAddress on create and update (C2)
- Added Contact.encryptPreference/keys/keysFirstSeen/lastMessageSeen/keyConflict, discovery-managed fields that trust-on-first-use pinning and the spec's Anti-Downgrade rule depend on never being writable via an ordinary client edit; Contact previously had no dedicated Base*Route class (unlike every other folder-scoped entity) and used BaseScopedChildRoute's generic create()/update() directly, which would have let any caller PATCH these fields freely - fixed by introducing BaseContactRoute, which rejects (400) any request attempting to set them directly (C3)
- Added the KeyVault entity (own table/collection, keyed by mailboxUid, no per-record ACL) holding wrappedKeys/masterKeyWraps, deliberately separate from Mailbox so private key material can never leak via an ordinary Mailbox fetch - no route yet, Group D wires up GET /mailbox/:id/keyvault and enrollment against it (C4)
- Added Key Vault Endpoints (Group D): GET/enroll/wrap-CRUD/re-key under /mailbox/:id/keyvault
- Added GET /mailbox/:id/keyvault (D1), deliberately checking the owning mailbox's own AccessControlList directly via ACLUtils.getRecord() rather than hasPermission(), since the latter has an unconditional "trusted users always have permission" bypass (confirmed by reading ACLUtils.js) that would give any admin blanket read access to every mailbox's private key material - a system admin gets 403 unless they are the mailbox owner or hold an explicit delegate ACLRecord
- Added POST /mailbox/:id/keyvault/keys (D2) to enroll a new key: for useType "encrypt" it calls the injected EncryptionCertificateAuthority.issue() itself against the caller's CSR, wiring up Group F's abstraction as anticipated; for useType "sign" it validates an already-issued certificate instead, since signing-cert enrollment against a public CA is a separate, asynchronous flow (SigningCertificateEnrollment) that has already completed by the time this call is made; the new PublicKey (Mailbox.keys) and WrappedPrivateKey/initial MasterKeyWraps (KeyVault) are written atomically via @Transactional()
- Added POST/DELETE .../keyvault/wraps (D3) to add or remove one MasterKeyWrap independent of key enrollment, identified by method + optional methodId
- Added PUT .../keyvault/rekey (D4), an atomic full replacement of wrappedKeys/masterKeyWraps/keys and the only real revocation mechanism for a captured wrap
- Added public key discovery endpoint (E1): GET /.well-known/rapidmx/keys/:hash
- Added server-side Discovery proxy (E2): GET /mailbox/:id/keys/lookup?addr= and util/KeyringUtils.ts
- Added util/KeyringUtils.ts's applyDiscoveredKeys(), implementing the Trust Model in one shared place: TOFU-pins the first key seen per useType; on a later different key, retains the pinned one and records Contact.keyConflict unless the pinned key is expired/revoked and the new one shares its issuer (sameIssuingCa(), an issuer-DN heuristic, not full chain verification, documented as such); and never lets a lookup that finds nothing regress keys/encryptPreference already on file (Anti-Downgrade) - this same function is designed to be reused by Group E3's inbound RapidMX-Key header processing, which has a KeyDiscoveryResponse-shaped payload already in hand rather than needing discoverAndMergeKeys()'s own DNS/HTTP lookup
- Added inbound RapidMX-Key header processing (E3): AuthenticationResultsUtils, RapidMxKeyHeaderUtils, wired into ScanQueueJob
- Added util/AuthenticationResultsUtils.ts's hasAlignedPassingDkim() as new territory for this codebase - nothing parses Authentication-Results today, since this app otherwise trusts whatever the upstream MTA hands it - as the specific gate specs/end-to-end_encryption.md requires before an inbound RapidMX-Key header may be acted on ("Receiving servers MUST verify DKIM before acting on the header and MUST treat an unverified header as absent"), failing closed on anything short of an aligned dkim=pass result
- Added util/RapidMxKeyHeaderUtils.ts's parseRapidMxKeyHeader(), implementing the header's own processing rules verbatim: exactly one header (all copies ignored otherwise), addr must match From, unknown non-_-prefixed attributes invalidate the whole header, keydata must parse as a real certificate; the signing certificate is never carried here per the spec, so the resulting PublicKey.useType is always "encrypt"
- Added extractHeaders() (plural) to MimeHeaderUtils.ts alongside the existing extractHeader(), needed since the ">1 RapidMX-Key header" and "Authentication-Results may repeat per hop" rules both require seeing every occurrence, not just the first
- Added outbound RapidMX-Key header attachment (E4)
- Added RapidMxKeyHeaderUtils.buildRapidMxKeyHeader(), the inverse of the existing parseRapidMxKeyHeader() used by E3's inbound processing
- Added Rotation Notification MDN extension fields (E5)
- Added optional rotatedKeyFingerprint/policyId fields to ReceiptUtils's build/parse functions, carried as RFC 8098 extension fields (X-RapidMX-Key-Fingerprint/X-RapidMX-Policy-Id) in the message/disposition-notification part - per spec these are a cache-invalidation hint only, never a trusted key source
- Added a new maybeRefreshRotatedKey(), called by processReceipt() whenever either extension field is present, which re-runs real Discovery (KeyringUtils.discoverAndMergeKeys()) against the authoritative endpoint rather than trusting the MDN's own claimed value - an MDN is only hop-authenticated, so installing its claimed fingerprint directly would let a forged MDN force a key change
- Added E2E feature specs
- Added DKIM+alignment checking, Disposition-Notification-To must-equal-From, and replay/uniqueness protection to MDN/receipt verification
- Added SSRF hardening in KeyDiscoveryClient: hostname validation, IP-literal rejection, redirect: "error", bounded-size streamed reads
- Added cert.checkEmail() validation against the mailbox address for signing-cert enrollment
- Added basicConstraints/keyUsage to leaf certs and build the subject DN structurally (no injection) in the PKI layer
- Added a regression test to ContactRoute.test.ts proving BaseContactRoute.create() actually rejects an empty displayName (400) - @Validate metadata cascades through every override via prototype-chain inheritance without needing to be redeclared, which a prior audit incorrectly flagged as broken
- Added validation-rejection integration tests across route classes
- Added a matching create-rejection test for both SQL and Mongo backends to every genuine gap found: TransportRule, ContactList, MailFilterRule, MailSignature, Note, TaskList, Task, Folder, CalendarShareLink, DistributionList
- Added validateWrappedPrivateKey() plus MAX_ENROLLED_KEYS/MAX_MASTER_KEY_WRAPS bounds, closing an unbounded-storage-growth DoS from wrappedKey/wrappedKeys having no field-shape validation at all
- Added a real HTTP/DB-backed regression test proving the specific failure scenario for every fix above, for both SQL and Mongo backends where applicable
- Added search operator grammar, Tier 3 candidates, and schema per specs/search.md - the mechanical, unambiguous server-side portion of the doc (companion to end-to-end_encryption.md's deferred search design), groups J/K/L/M of the scoping breakdown; client-side work (local FTS5 index, progressive-results UI, client-side re-scoring/merge) is out of scope for this repo
- Added folderUid, flags[], hasAttachments to SearchDocument, powering the in:/is:/has:attachment operators
- Added SearchDocument.metadataOnly / SearchResult.metadataOnly, set by SearchIndexJob when a message is encrypted (subject/body/attachmentText intentionally excluded), so a client can tell a participants-only score apart from a full-content one
- Added structured filter fields to SearchQuery (from/to/cc/subject/hasAttachment/before/after/folderUid/flags) per §14's query operator grammar - already parsed by the caller per the spec ("parsing happens once, client-side"), not raw operator text; all three providers (Mongo/Postgres/OpenSearch) translate these into real filter predicates
- Added CandidateQuery/CandidateResultPage types and SearchProvider.candidates(), implemented by all three providers, returning identifiers only ranked on server-visible metadata (participants/dates/folder/flags), never content, per §6/§12's Tier 3 design
- Added GET /search/candidates to BaseSearchRoute for the new Tier 3 candidate query
- Added CalendarEvent encryption provenance and skip auto-send for encrypted invites
- Added MTA impl for AWS SES

### Changed
- Update NOTES.md noting the 0.4.0 publish and that @rapidmx/server has dropped its yarn patch for a plain semver dependency on it
- Refine delivery/read receipts to a three-tier same-organisation/federated-peer/external scoping model instead of the previous binary internal/external one, per specs/end-to-end_encryption.md's Scoping Principle (receipts are a disclosing capability and MUST default to same-organisation only, not lumping a federated peer in with plain external correspondents)
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Stop feeding S/MIME-encrypted mail's ciphertext into server-side pipelines that assumed a readable body - a standing correctness gap independent of the rest of the E2E encryption feature, since any externally-received encrypted mail already hits these code paths today
- Stop indexing body/attachment text in SearchIndexJob for an encrypted message (subject/participants/dates are unaffected - they're outer RFC 5322 headers, never encrypted by CMS EnvelopedData)
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Note (not silently resolved): the spec's own worked example for the discovery hash is SHA-1-length (32 z-base32 chars) while its prose and formula both say SHA-256 (which produces 52) - implemented per the twice-repeated explicit SHA-256 statements, documented in computeKeyDiscoveryHash()'s doc comment for whoever corrects the spec's example
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Split the single logoUrl asset into a full logo (watermark/sign-in-style use) and a separate, independently configurable iconUrl for compact nav-header use, mirroring the existing logo upload/URL/delete plumbing end to end: BrandingMongo/BrandingSQL gain iconUrl/iconBlobKey/iconContentType columns, and BaseBrandingRoute gains POST/GET/DELETE /branding/icon mirroring the logo endpoints, plus PUT /branding now clears and deletes an orphaned icon blob the same way it already does for the logo
- Export readPublicBranding()/fetchBrandingPropsForSSR() so a downstream server's own wwwRoute/AdminConsoleRoute-style routes can read current branding in-process (no HTTP round trip) to render it server-side on the very first byte of the response, needed by rapidmx/server's own SSR title/favicon/stylesheet work
- Bump to 0.5.0
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Wire real federation detection into the three-tier receipt classification (roadmap item A5), replacing the always-false stub A2 shipped with - closes out Group A now that Group B's resolveFederationPolicy() exists
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Persist Message.encrypted (a prerequisite Group G's ScanPipelineResult.encrypted never made durable) and use it for roadmap item I1: stop AttachmentExtractionJob from running text extraction against an encrypted message's attachments
- Stamp Message.encrypted from ScanPipelineResult.encrypted at every point a Message is actually created or persisted from a scan: ScanQueueJob's two inbound delivery sites (primary + rule-copy), and BaseMessageRoute.send()'s outbound path via a new field on MailSendUtils.ScanAndRelayResult - needed because AttachmentExtractionJob and the eventual iTIP-to-CalendarEvent propagation (roadmap item I3) run well after the original ScanPipelineResult is gone, so Message itself has to carry the signal forward
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Set CalendarEvent.encrypted from the source message's own Message.encrypted (ScanQueueJob.processItipRequest()'s create branch only) when a REQUEST first materializes an event, deliberately never touched by the update branch - encryption state is sticky per the spec, preserved across every later resend/update/recurrence instance rather than recomputed from whatever message triggered that particular mutation
- Note this is currently the only part of the spec's "Derived Entities" section implemented: it's a provenance flag only, not actual field-level encryption of title/location/attachments, since today's iTIP pipeline only ever reads a text/calendar part that's already plaintext-visible to the server - a genuinely S/MIME-encrypted invitation has no such separately-visible part at all (the whole point of util/SmimeUtils.ts's isEncryptedBody() check), so this flag is set defensively for forward-compatibility rather than something the current pipeline exercises in the common case; real field-level encryption awaits the deferred client-side E2E composition/decryption work
- Defer I4 (an admin setting for automatic same-org derived-entity protection) - there is no code in this pass that ever applies derived-entity field-level encryption, so a toggle would have nothing to gate; revisit alongside the real encryption work
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Use three states (automatic/optional/prohibited), not a boolean, configured independently for encryptSameOrg/encryptFederated/encryptExternal - deliberately three because "not by default" (optional) and "not allowed" (prohibited) are materially different administrative intents a plain on/off toggle can't distinguish; defaults to "optional" for all three tiers since encryption is a protective capability with no reason to default more restrictively for federated/external than the spec's stated same-organisation default
- Model this directly on BaseBrandingRoute.ts, the one existing precedent in this codebase for a runtime-editable admin setting rather than static @Config: a singleton row at a fixed uid, the same TOCTOU-tolerant findOrCreate(), PUT gated by @RequiresTrustedRole() plus recordAuditLog(); differs from Branding in one deliberate way - GET requires authentication (any logged-in user, not just admins, since a compose UI needs this to decide what controls to offer) rather than being fully public
- Leave the separate digital-signing enable/disable toggle as a plain @Config boolean, unaffected - the spec only requires tri-state granularity for encryption, not signing
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Upgrade @rapidrest/service-core to ^2.0.0 (2.x peer range) for its query-string DSL overhaul: regex()/exists() operators, nested $or on SQL, tree-shaped query forms, sort-field validation, and fixes to MongoDB not()/ne() compilation and in()/nin()/range() type coercion
- Audit restapi's own query-DSL usage against the documented breaking changes (like() now uses glob syntax, unrecognized operators reject with 400) and confirm no impact: this codebase never uses the DSL's like() at all (the one alias-substring-match call site deliberately bypasses it with a raw TypeORM Raw() operator instead, for %/_ escaping the DSL didn't support), and every operator actually used (gte/gt/lte/lt/ne) is a recognized name unaffected by the stricter rejection rule
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Simplify BaseBookingRoute.countBookingsOnDay() back to a single range() count now that @rapidrest/service-core 2.0 fixes range()'s Date-coercion bug
- Confirm by reading the installed package's ModelUtils.coerceOperand() that both range() operands now go through the same Date-aware coercion gte()/lte() already used, resolving the exact bug the old two-subtracted-counts workaround existed for
- Keep range() inclusive on both ends (TypeORM Between() / Mongo $gte+$lte) by setting the upper bound to dayEnd minus one millisecond, preserving the exact same half-open [dayStart, dayEnd) window the workaround computed - otherwise a booking starting at exactly the next day's midnight would double-count into both days; existing maxPerDay same-day/next-day tests pass unchanged
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Mirror the DkimKeyProvider/SearchProvider pattern rather than hand-rolling certificate issuance inline: issue(identity, csr) takes a client-generated PKCS#10 CSR (proof of possession, and Vault/OpenBao-API-compatible from day one) rather than a bare public key
- Implement LocalX509CertificateAuthority to generate and persist a self-signed P-256 CA root on local disk (0600 key) using @peculiar/x509, verify each CSR's self-signature before issuing, and treat revoke() as a no-op since it has no CRL/OCSP responder - that's left to a production backend such as the still-to-come OpenBaoPkiCertificateAuthority
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Implement a thin adapter to a self-hosted OpenBao/Vault Community Edition PKI secrets engine's HTTP API - a genuinely free, self-hosted, no-contract backend, the same category as PostfixSendmailTransport being the recommended MailTransport; issue() posts the CSR to POST /v1/<mount>/sign/<role>, and revoke() identifies the certificate by serial number rather than fingerprint (Vault/OpenBao's own addressing scheme), so this class persists a small local fingerprint -> serialNumber map on issue() rather than pushing that translation onto callers
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Keep this a separate interface from EncryptionCertificateAuthority, not a variant of it - enrollment against a publicly-trusted CA is inherently asynchronous (startEnrollment()/checkStatus()), and the spec allows disabling signing certificates entirely for closed deployments, which this gives a clean "don't register a second token" story for
- Implement ManualSigningCertificateEnrollment to work with any public CA an admin chooses by hand: it validates the CSR's self-signature on startEnrollment(), persists pending enrollments to a small local JSON file (matching OpenBaoPkiCertificateAuthority's serial-map precedent from the previous commit), and verifies an uploaded certificate's public key actually matches the original CSR before accepting it via uploadCertificate()
- Defer the REST admin route for the certificate-upload step - startEnrollment() has no caller yet until Group D's key-vault enrollment endpoint exists, so a route with nothing driving traffic to it would be premature infrastructure
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Audit-log every mutating action, and add a FakeEncryptionCertificateAuthority test double (in-memory, real @peculiar/x509 issuance) since the default NullEncryptionCertificateAuthority throws
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Implement the server side of the federation discovery protocol whose client half (util/KeyDiscoveryClient.ts) shipped in Group B - unauthenticated, @RateLimit()-decorated per the spec's per-source-IP requirement (no new infrastructure, @RateLimit() already keys an independent per-IP counter)
- Look up Mailbox by its indexed keyDiscoveryHash column; the not-found and no-keys-published cases are byte-for-byte identical (200, not 404) by construction, both reducing to the same NOT_PUBLISHED_RESPONSE built from Mailbox.encryptPreference/keys' own class-level defaults, so there's no hand-maintained "make these two responses match" logic to drift out of sync
- Compute escrow from whether the mailbox's KeyVault holds any MasterKeyWrap with method "escrow" - the boolean disclosure the spec's Public Endpoint section already requires, unaffected by the deferred full Escrow Scoping work; ETag is a SHA-256 of the response body, and If-None-Match is honored with a 304
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Implement Discovery server-side as specs/end-to-end_encryption.md requires - browsers have no DNS TXT API and would hit CORS fetching an arbitrary third-party domain directly - so this endpoint performs the _rapidmx TXT lookup (util/FederationUtils.ts) and discovery-endpoint fetch (util/KeyDiscoveryClient.ts) itself and persists the result onto a Contact in the caller's own address book
- Use ordinary ACLUtils.hasPermission() (with its usual trusted-role bypass) here, deliberately unlike BaseKeyVaultRoute, since this only ever touches the address book, never private key material
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Wire this into ScanQueueJob.deliverMessage() via a new processInboundRapidMxKeyHeader() step that runs for every inbound message regardless of filtering/filing outcome, reusing Group E2's KeyringUtils.applyDiscoveredKeys() for the same TOFU/conflict/anti-downgrade merge logic; Contact.lastMessageSeen is stamped for an existing Contact even when nothing new was found, but a brand-new Contact is only created when a key was actually discovered, since lastMessageSeen alone isn't reason enough to add every random sender to the address book
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Make BaseMessageRoute.send() announce the sending mailbox's active encryption key alongside the existing Disposition-Notification-To attachment, mirroring that same pattern: only a non-revoked, non-expired "encrypt" key is ever announced (a "sign"-only key never produces a header)
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Make sendDispositionNotification() announce the reporting mailbox's own active encrypt-key fingerprint on the sending side, mirroring E4's outbound RapidMX-Key logic
- Refactor the Contact create-or-update persistence tail shared by E3's processInboundRapidMxKeyHeader() and the new maybeRefreshRotatedKey() into persistContactKeyUpdate()
- Complete Groups C/D/E of the DS/E2E encryption roadmap
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Require a configured, trusted authserv-id for Authentication-Results and fail closed when unset, closing forged-DKIM key-pinning
- Reject Mailbox.keys/keyDiscoveryHash outright on a client PUT (value-aware, so empty-array bodies still work), closing CA-bypass and discovery impersonation
- Move ContactSQL's epoch-ms columns to type "double", fixing silent mail-drop on Postgres/MySQL ("integer out of range" on the old 32-bit int mapping)
- Close escrow wraps being addable/removable/fakeable through the owner/delegate endpoints
- Scope the discovery endpoint by Host header and close its timing oracle
- Reject sending the OpenBao token over plaintext HTTP off-loopback
- Key RapidMX-Key on the From header instead of envelope-from
- Hoist N+1 domain/DNS queries in BaseMessageRoute.send() out of the per-recipient loop
- Make encrypted-attachment handling consistent between ScanQueueJob and TransportRuleUtils
- Document Escrow RBAC, CRL/OCSP infra, DKIM-oversigning automation, and DNSSEC validation as required deployment configuration in README - intentionally out of scope as net-new features, not bugs
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Apply RapidREST conventions to close several route-convention gaps found in an audit, with a regression test
- Move BaseEncryptionPolicyRoute.update()'s inline enum validation into a @Validate("validateUpdate") method, run by the framework strictly before the handler instead of inline at the top of it
- Move BaseBookingRoute.book()'s bookerName/bookerEmail shape checks into a @Validate("validateBook") method, leaving slot-availability checks that need a DB lookup in the handler as business-rule checks
- Apply @Before("rejectWrite") to BaseAuditLogRoute's create/update/delete/truncate, matching BaseACLRoute's own @Before-guard convention, with handlers keeping a defensive direct call to rejectWrite() too
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Leave AuditLogRoute (writes are blocked outright, 403 not 400), KeyDiscoveryRoute and DomainRoute.dkim (no rejectable input by design/scope), Attachment (upload path, not model-validated JSON create), DistributionListDomains (already has a real, narrowly-scoped domain-verification test), and EncryptionPolicyRoute (already has a real enum-rejection test) untouched after confirming each doesn't have a real gap
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Validate BaseKeyVaultRoute.enrollKey()'s body.masterKeyWraps instead of passing it straight to persistence unvalidated, unlike its sibling addMasterKeyWrap()/rekey() endpoints - closes the exact escrow-spoofing gap validateMasterKeyWrap() exists to prevent, just on the third call site that was missed
- Sanitize BaseAttachmentRoute's filename at upload and escape it at download, closing a Content-Disposition injection where an embedded quote could break out of the quoted value and spoof the saved filename
- Make BaseMailIngestRoute.deliver() share one blob per deliver() call for direct-mailbox recipients instead of writing a fresh copy per recipient, matching the distribution-list branch a few lines down which already does this
- Batch MailboxQuotaRecalcJob's attachment queries via the query DSL's in() operator in chunks of 100 instead of issuing one query per message with attachments (N+1)
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Split SearchDocument's participants[] into from/to[]/cc[], keeping participants[] as the union for existing free-text ranking, per §14's "Required Schema Changes"
- Wire all of the above into SearchIndexJob.buildDocument() for Message, the only entity type this job indexes today
- Switch PostgresFullTextSearchProvider from plainto_tsquery to websearch_to_tsquery for the free-text portion, and add an ALTER TABLE ADD COLUMN IF NOT EXISTS step so an upgrading deployment picks up the new columns (CREATE TABLE IF NOT EXISTS alone is a no-op against an existing table)
- Match subject: as an additional AND predicate scoped to the subject field alone, not a replacement for full-field free-text ranking
- Make BaseSearchRoute's q optional, gated on "at least one of q or a structured filter" instead of requiring q unconditionally, so a pure structured-filter query like subject:budget is valid
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Replace CalendarEvent.encrypted (a flat boolean) with encryptionOrigin: EncryptionOrigin ("none"/"derived"/"originated") per specs/search.md §3 "Provenance", so a client can explain why an event is encrypted ("received encrypted from bob@orgb.com" vs. "you chose to encrypt this") rather than collapsing both into one indistinguishable flag
- Set "derived" on create and "none" otherwise in ScanQueueJob's inbound iTIP pipeline (the only place that sets this today), continuing to never touch it on update so encryption state stays sticky per the spec; "originated" is for a client explicitly marking its own outbound invite as encrypted via ordinary CRUD, not specially protected since this field only gates indexing/send behavior, not access
- Make MeetingSchedulingJob skip composing/sending a plaintext iTIP REQUEST/CANCEL entirely for an encryptionOrigin: "originated" event, since that's the client's own responsibility end to end (compose, encrypt, send), matching this repo's scope boundary that real crypto only ever happens client-side; still stamps inviteSequenceSent/cancelNoticeSentAt so the job doesn't keep re-visiting an event it will never actually send, the same "skip the send, still mark handled" shape isRedundantOccurrenceCancel already used
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Moving Ses transport impl to this repo

### Fixed
- Fixed TransportRuleUtils.bodyContains to cleanly never-match an encrypted body's empty preview; also fixes a real bug found along the way - mailparser folds an encrypted body's own ciphertext into parsed.attachments as a synthetic node (a real EnvelopedData message has no separate visible attachment inside it), which was making hasAttachment/attachmentNameContains false-positive for encrypted mail
- Fixed AttachmentExtractionJob.processAttachment() to look up the parent message first and skip straight to stamping an empty extractedTextBlobKey (exactly like today's unsupported-MIME-type path) when it's encrypted, never handing ciphertext to ExtractorRegistry - mirrors the same encrypted-body gate already applied to ScanPipeline/SearchIndexJob/TransportRuleUtils in the earlier Group G commit
- Fixed two bugs caught during testing: EncryptionPolicySQL's PolicyState (string-literal-union) columns needed an explicit @Column({ type: "varchar" }) since TypeScript's emitDecoratorMetadata can't reflect a union type into a primitive constructor better-sqlite3 can resolve on its own (the same gotcha CalendarEventSQL.status already documents for real enums), and update() validated incoming policy values after findOrCreate() had already materialized the singleton row so a rejected (400) request still had the side effect of creating it on what should have been its first write - validation now runs first
- Fixed critical/high security findings from two adversarial reviewers auditing the E2E encryption feature (v0.4.0..HEAD) plus the service-core 2.0 migration
- Fixed sameIssuingCa() to use real signature-based self-signed detection instead of DN-string comparison, and always recompute discovered-key fingerprints from the actual certificate rather than trusting them as asserted
- Fixed rekey() to validate against already-enrolled fingerprints instead of publishing arbitrary unvalidated certificates
- Fixed the CA key generation race to be atomic
- Fixed EncryptionPolicyMongo to extend BaseMongoEntity instead of BaseEntity, a copy-paste bug that lost _id mapping and the uid/version unique index
- Fixed anti-downgrade to use the message Date instead of wall-clock
- Fixed findings from a second adversarial review pass, covering the codebase again post-convention-fixes: one reviewer focused on the E2E encryption/key-vault surface, ACL correctness, and concurrency; the other on the remaining routes, jobs, and utilities
- Fixed removeMasterKeyWrap() to reject an ambiguous request instead of silently deleting every wrap of a method when methodId was omitted and more than one existed
- Fixed MeetingSchedulingJob.sendInvites()'s unfiltered, unsorted query, which could permanently starve a genuinely new event out of the fetch window once CalendarEvent rows exceeded batch_size - added a status filter and sort: -dateModified so a new/edited event always surfaces first
- Fixed BaseMailboxRoute/BaseDistributionListRoute to re-validate a changed primarySmtpAddress on update (including the dedicated updateProperty() rename endpoint, which bypasses the @Validate dispatch pipeline entirely since it calls update() in-process) - previously let a caller silently point their own mailbox/list at another entity's address, hijacking its mail flow; now re-runs the same verified-domain/collision checks create() applies, only when the address is genuinely changing
- Fixed OpenSearchProvider.search() to populate SearchResult.snippet via a highlight block, closing a pre-existing gap the spec calls out explicitly (§1) where the interface declared the field but no provider ever set it

### Removed
- Removed @rapidrest/cli as a dep

## [0.4.0] - 2026-09-09

### Added
- Added a DkimKeyProvider abstraction (FsDkimKeyProvider/NullDkimKeyProvider) so a deployment can opt into automatic per-domain DKIM key generation instead of the previous admin-fills-it-in-by-hand-only model
- Added GET /internal/mta/domain to BaseMailIngestRoute so an MTA's relay-domain acceptance check can stay in sync with this app's own Domain database dynamically, with no MTA restart needed
- Added test/dkim/FsDkimKeyProvider.test.ts, test/routes/{mongo,sql}/DomainRoute.dkim.test.ts, new /internal/mta/domain cases in the existing MailIngestRoute tests, and a real-DI regression test for the ScanPipeline config-default fix

### Changed
- Wire DkimKeyProvider into BaseDomainRoute.create() (auto-fills dkimSelector/dkimPublicKey unless the caller already supplied both) and dnsSetup() (lazily backfills a pre-existing domain missing them)
- Register NullDkimKeyProvider as the default test double, required because @Inject throws when nothing at all is registered under a token
- Document the new /internal/mta/domain endpoint in transport/MTAIngestAdapter.ts alongside the existing resolve/deliver contract
- Update Domain.dkimSelector/dkimPublicKey doc comments, which previously asserted this library never generates or stores DKIM key material

### Fixed
- Fixed ScanPipeline's allowedTags @Config field having no default, which made ObjectFactory.initialize() throw for any deployment that never explicitly sets mail:scan:sanitize:allowed_tags, silently disabling all spam/AV scanning

## [0.3.1] - 2026-09-09

### Added
- Added an IANA's Special-Use Domain Name now skips validation and is automatically set as verified

### Changed
- Cleaning up contributors
- Updated readme

## [0.3.0] - 2026-09-09

### Added
- Added BaseMailboxRoute.autoProvision()/listDomains() and enforce the mail:domains allowlist in create()
- Added mail:auto_provision:static_aliases as a bypass for consumers with no reachable auth-server, e.g. a dev-mode server that can't self-fetch its own listening address mid-request
- Added TaskList entity (mailboxUid, name) as a direct structural copy of ContactList, with full mongo+sql CRUD routes and permission tests
- Added Task.taskListUid/assignedTo, Contact.categories, and Folder.color fields
- Added Contact.favorite/Task.myDay as optional fields instead of required-with-default, since a required boolean with only a TS-level default breaks real SQL schema migration against existing rows
- Added MailFilterRule entity (mailbox-scoped inbox rules: conditions, ordered actions, stopProcessingRules), evaluated in ScanQueueJob against newly-delivered mail with move/copy/delete/mark-as-read/forward actions
- Added Message.scheduledSendTime and a deferred-send branch in BaseMessageRoute.send() that moves the message to Outbox instead of relaying, plus a new ScheduledSendJob that relays due messages
- Added MailSignature entity (roaming, OWA-style) with a resolveDefaultSignature() helper for composing clients to share
- Added automatic out-of-office replies via resolveActiveOof(), combining Mailbox.oofEnabled with a new CalendarEvent.autoReplyEnabled/autoReplyMessage window, isAutoReplyEligible() for RFC 3834 loop prevention, and a new OofReplySuppression entity with OofReplySuppressionCleanupJob to throttle repeat replies per sender
- Added src/util/IcsUtils.ts for hand-rolled RFC 5545/5546 ICS generation and parsing (buildEventIcs/parseIcsEvent), including RRULE/EXDATE for master events, RECURRENCE-ID for single-occurrence overrides, and TZID conversion via Node's built-in Intl
- Added MeetingSchedulingJob support for sending iTIP REQUEST invites on CalendarEvent create/update (tracked via inviteSequenceSent) and CANCEL notices on cancellation/deletion (tracked via cancelNoticeSentAt), with recurring-series-aware de-duplication
- Added inbound iTIP processing to ScanQueueJob, detecting a text/calendar part and processing REQUEST (create/update the recipient's calendar entry), REPLY (update the organizer's attendee status), and CANCEL (soft-delete one occurrence or the whole series)
- Added BaseCalendarEventRoute auto-bumping of sequence on scheduling-relevant updates and a POST /:id/respond endpoint so a REST client can accept/decline/tentative without parsing email, always sending a real iTIP REPLY to the organizer
- Added a mail-enabled DistributionList entity (admin-only CRUD) whose membership can include internal mailboxes, nested lists, and genuinely external addresses
- Added recursive inbound list expansion with a cycle guard and depth cap, fanning out to internal members via one Reply-To/List-Id/List-Unsubscribe-rewritten copy and relaying directly to external members via MailTransport
- Added unsubscribe handling: a member emailing the list with Subject: unsubscribe is removed and gets a confirmation
- Added an admin-only TransportRule entity evaluated once per SMTP transaction in BaseMailIngestRoute.deliver(), before per-recipient resolution/fan-out, separate from the mailbox-scoped MailFilterRule that runs later per-recipient in ScanQueueJob
- Added TransportRule conditions mirroring MailFilterRule's substring-match model (from/subject/body/recipient contains, hasAttachment, attachment name) plus an anyRecipientExternal check against mail:domains
- Added reject, quarantine, add_header, and add_recipient transport-rule actions, with quarantine stamping IngestQueueEntry.quarantineReason so ScanQueueJob forces that verdict once scanning completes
- Added MimeHeaderUtils.ts, extracting the raw-MIME header read/rewrite primitives shared by distribution lists and transport rules
- Added isResource/resourceType/autoAcceptBookings/allowConflicts/bookingWindowDays/maxDurationMinutes fields to Mailbox so it can represent a bookable resource, mirroring Exchange's room/equipment auto-processing
- Added automatic accept/decline of inbound iTIP REQUESTs to resource mailboxes in ScanQueueJob, via a new expandOccurrences() RRULE occurrence expander that checks duration/booking-window policy and full recurring-series conflict detection
- Added BaseMessageRoute.recall(), composing an X-RapidMX-Recall-Of control message to a sent message's original recipients
- Added recall handling to ScanQueueJob, deleting the recipient's still-unread copy (leaving a read copy alone) and reporting the outcome back to the sender as a plain email
- Added Message.conversationId, computed once at creation time from References/In-Reply-To/Message-ID via a new deriveConversationId() utility, populated on both ingest (ScanQueueJob) and send (MailSendUtils)
- Added BaseMessageRoute.conversations(), a mailbox-wide endpoint that groups messages by conversationId across every folder, mirroring BaseFolderRoute.find()'s mailbox-level ACL check
- Added a durable AuditLogEntry (Mongo/SQL) recorded for DistributionList/TransportRule create/update/delete, trusted-caller Mailbox creation, and Message delete/recall, mirrored through EventUtils.record()
- Added a read-only audit-log route that blocks writes for every caller including admins, since ACLUtils.hasPermission() bypasses class ACL for trusted users and a deny-all grant alone can't stop them
- Added a DB-backed, admin-managed Domain entity with full CRUD, replacing the static mail:domains config everywhere it was consulted with one consistent enabled-and-verified definition
- Added TXT-record-token domain ownership verification, checked periodically by DomainVerificationJob and on demand via a manual verify action, both through a pluggable DnsResolver interface
- Added a read-only GET /:id/dns-setup endpoint that computes and live-checks the MX/SPF/DKIM/DMARC records a domain needs beyond ownership proof
- Added DnsResolver.resolveMx() alongside the existing resolveTxt()
- Added mail:dns:mx_hostname config, driving the MX/SPF recommendations for every domain
- Added DKIM/DMARC recommendation support without ever generating or storing key material, since an admin supplies the selector and public key from their own MTA/OpenDKIM setup
- Added MessageClassification enum (focused/other) and an optional Message.inferenceClassification field, absent meaning treat as Focused for existing mail
- Added FocusedInboxOverride entity (mailboxUid + senderAddress -> classifyAs) with a compound index and a deny-all class ACL, managed through a BaseScopedChildRoute scoped to the owning mailbox
- Added FocusedInboxUtils.classifyMessage() as a pure function with precedence explicit override, then bulk/automated indicators, then internal sender, then known correspondent, then spam score, defaulting to Focused
- Added lazy classification in ScanQueueJob.deliverMessage() that short-circuits for junk-routed and non-Inbox mail before any of the three extra lookups run
- Added a ScanPipeline raw-header reader for listUnsubscribeHeader, since mailparser folds every List-* header into one structured list key
- Added POST /messages/:id/classify with { classifyAs, applyToSender } for the Always move to Other gesture
- Added BookingType/Booking entities (Mongo + SQL) with a deny-all class ACL, since anonymous access is granted only by the public route resolving a slug or manageToken, never through the ACL system
- Added FreeBusyUtils.computeBusyWindows(), lifting the conflict-detection core out of ScanQueueJob.decideResourceBooking() into a reusable pure function that also filters cancelled/free-status events
- Added BookingUtils.generateCandidateSlots()/subtractBusy() as pure slot-math functions, converting local availability windows to UTC via the now-exported IcsUtils.convertLocalToUtc() so a 09:00 window stays 09:00 local across a DST transition
- Added BaseBookingTypeRoute as the host's ordinary mailboxUid-scoped BaseScopedChildRoute CRUD, with slug normalization/collision checking and availability validation
- Added BaseBookingRoute as the anonymous half, built in the shape of BaseMailIngestRoute with its own repos and ignoreACL: true throughout, wrapping the CalendarEvent+Booking write pair in @Transactional() and rate-limiting its three mutating endpoints
- Added Gmail-style plus-addressing so user+tag@domain.com resolves to mailbox user@domain.com at delivery time
- Added AddressUtils.stripPlusTag(), stripping everything from the first + in the local part onward without touching the domain
- Added a third fallback tier to BaseMailIngestRoute.findMailboxByAddress(): exact primarySmtpAddress, then exact aliasAddresses, then both again against the plus-stripped base address, with exact matches always winning first
- Added mail:plus_addressing:enabled config, default on
- Added an admin-managed, publicly-readable Branding record (logo, product title/company name, stylesheet, web-client UI chrome) for a downstream server or web client to render
- Added Branding as a singleton entity (fixed uid: branding), created lazily on the first admin write, with a deny-all class ACL since the public read is a route-level decision, not an ACL grant
- Added BaseBrandingRoute as a bespoke class mixing BaseBookingRoute's unauthenticated public reads with BaseDomainRoute's @RequiresTrustedRole() admin writes and recordAuditLog() usage
- Added logoUrl/stylesheetUrl support for both a plain external URL and an upload through POST /branding/logo or /branding/stylesheet, storing the file via BlobStore and cleaning up the replaced blob when switching modes
- Added a genuine RFC 3798 Message Disposition Notification implementation on both the generating and parsing sides, so the indicator mechanism works regardless of who generated the receipt
- Added util/ReceiptUtils.ts, building and parsing real multipart/report report-type=disposition-notification messages via nodemailer's MimeNode builder, using Disposition displayed for read receipts and processed for delivery receipts
- Added Message.requestReceipt and Mailbox.alwaysRequestReceiptInternal/External so send() attaches Disposition-Notification-To when it applies to any recipient and seeds one receiptStatus roster entry per recipient
- Added Mailbox.autoSendReceiptsInternal/External, classified via the new DomainUtils.isInternalAddress(), auto-sending or holding a receipt pending approval via POST /:id/receipt/approve or /decline
- Added delivery-receipt generation to ScanQueueJob at delivery time and inbound-MDN detection correlated by (mailboxUid, messageId) and Final-Recipient, never filing the MDN as a visible message
- Added BaseMessageRoute's update() override to trigger the read receipt on flags.read's first false-to-true transition

### Changed
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Change Mailbox/DistributionList uid to derive from the entity's own address instead of a random id, closing a cross-entity address-collision gap
- Upgrade @rapidrest/service-core to ^1.5.0 for @RequiresTrustedRole(), replacing hand-rolled trusted-role checks with the framework's own decorator
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Changing in-process db query filtering to use db-native query filtering
- Upgraded @rapidrest/service-core to 1.6.0
- Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
- Note known limitations: the double-booking race is narrowed but not closed, manageToken has no expiry/GC job, and recurring busy blocks inherit expandOccurrences()'s DST-naivety
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Changed `IcsUtils.formatDateUtc()` to take a `Date` or `string`. This fixes an issue with documents retrieved from MongoDB that return as strings.
- Note this is scoped to mailbox delivery-routing only, not authentication/login and not DistributionList addresses, since the delivered message's To: header is parsed independently and untouched by this routing change
- Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Updated claude intsructions regarding commit messages
- Updated CI build workflow
- Upgraded all dependencies

### Fixed
- Fixed ScanQueueJob hardcoding Message.subject/bodyPreview to empty strings instead of using the values ScanPipeline already parsed
- Fixed ScheduledSendJob silently failing to clear scheduledSendTime on the SQL backend, since TypeORM's Repository.update() skips undefined properties and only an explicit null clears a column
- Fixed scanAndRelay() to guarantee every message has a Message-ID before relay, generating and injecting one when the composing client didn't set it, applied consistently for both immediate sends and ScheduledSendJob
- Fixed ScanPipeline to strip angle brackets from In-Reply-To/References/Message-ID consistently, since mailparser left them bracketed unlike this library's own send-side normalization, which would have silently broken conversation grouping and recall()'s cross-mailbox Message-ID matching
- Fixed a latent case-sensitivity bug in domain matching, surfaced by moving to real lowercase-normalized Domain rows instead of static config
- Fixed CI publish job
- Fixed @rapidrest/service-core's @RateLimit decorator never calling next() on its success path, upgrading to 1.7.1
- Fixed GET /branding to never 404, returning all-empty defaults before anything has been configured
- Fixed ScanQueueJob.processReceipt() trusting an inbound MDN's claimed Final-Recipient without checking it matched the message's actual envelope sender, letting anyone who could email a mailbox forge fake delivery/read receipts for arbitrary addresses
- Fixed declining a pending receipt not durably sticking, since marking a message unread then read again re-triggered the same hold-for-approval flow it was meant to close
- Fixed a distribution list whose address contained a plus sign being silently shadowed by an unrelated mailbox via the plus-addressing fallback, since mailbox resolution ran before the distribution-list check
- Fixed the same plus-addressing fallback letting a sender evade a transport rule scoped to a specific recipient by tagging the address
- Fixed a legally-folded Original-Message-ID header corrupting MDN-to-message correlation
- Fixed duplicate recipient addresses seeding duplicate, unmergeable receipt-status rows
- Fixed a narrow TOCTOU race on the branding singleton's create-if-missing during the very first concurrent write

### Removed
- Removed a dead, unreachable !aclRepo guard in MailboxRouteMongo/SQL's findAccessibleMailboxUids(), closing a lines-coverage gap that had persisted across sessions

## [0.2.0] - 2026-09-07

### Added
- Added EAS Sync multi-collection, RemoteWipe, and OOF fields to models

### Changed
- Eagerly provision Inbox/Drafts folders when a mailbox is created
- - BaseMailboxRoute.create() now creates the Inbox and Drafts folders immediately, since a brand-new mailbox with neither is unusable in a webmail client (MailShell/Compose both require them to exist)
- - MailboxRouteMongo/MailboxRouteSQL supply the concrete Folder class for the new provisioning step
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- DeviceSyncState gains folderCollectionClasses (remembers a synced
- collection's Class so it can be omitted on later Sync requests, per
- MS-ASCMD) and remoteWipeRequested/remoteWipeAccountOnly/
- remoteWipeAcknowledgedAt (MS-ASPROV RemoteWipe). Mailbox gains
- oofEnabled/oofMessage/oofStartTime/oofEndTime (MS-ASSettings Oof).
- oofMessage needed @Nullable despite being a required string: this
- framework's ObjectUtils.validate() treats an empty string as
- equivalent to null/undefined for any non-nullable field, and this
- field's natural default (no OOF message configured) is "". Also fixes
- a related test-helper gap in MailboxRoute.test.ts (SQL): an unset
- nullable Date column round-trips as null, not undefined, which a
- strict toEqual was treating as a real mismatch.
- These fields are consumed by the in-progress @rapidmx/activesync work
- (client-Class-omission on Sync, Provision RemoteWipe flow, Settings
- Oof) via a local portal: link, not a version bump.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Eagerly provision Calendar, Contacts, and Tasks folders when a mailbox is created
- - BaseMailboxRoute.create() now also creates the calendar/contacts/tasks well-known folders alongside the existing inbox/drafts, since the webmail client now has permanent nav destinations for each
- - Update MailboxRoute integration tests' expected folder list accordingly
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

[Unreleased]: https://github.com/rapidmx/restapi/compare/v0.36.0...HEAD
[0.36.0]: https://github.com/rapidmx/restapi/compare/v0.35.0...v0.36.0
[0.35.0]: https://github.com/rapidmx/restapi/compare/v0.34.0...v0.35.0
[0.34.0]: https://github.com/rapidmx/restapi/compare/v0.33.0...v0.34.0
[0.33.0]: https://github.com/rapidmx/restapi/compare/v0.32.0...v0.33.0
[0.32.0]: https://github.com/rapidmx/restapi/compare/v0.31.0...v0.32.0
[0.31.0]: https://github.com/rapidmx/restapi/compare/v0.30.1...v0.31.0
[0.30.1]: https://github.com/rapidmx/restapi/compare/v0.30.0...v0.30.1
[0.30.0]: https://github.com/rapidmx/restapi/compare/v0.29.0...v0.30.0
[0.29.0]: https://github.com/rapidmx/restapi/compare/v0.28.1...v0.29.0
[0.28.1]: https://github.com/rapidmx/restapi/compare/v0.28.0...v0.28.1
[0.28.0]: https://github.com/rapidmx/restapi/compare/v0.27.1...v0.28.0
[0.27.1]: https://github.com/rapidmx/restapi/compare/v0.27.0...v0.27.1
[0.27.0]: https://github.com/rapidmx/restapi/compare/v0.26.0...v0.27.0
[0.26.0]: https://github.com/rapidmx/restapi/compare/v0.25.2...v0.26.0
[0.25.2]: https://github.com/rapidmx/restapi/compare/v0.25.1...v0.25.2
[0.25.1]: https://github.com/rapidmx/restapi/compare/v0.25.0...v0.25.1
[0.25.0]: https://github.com/rapidmx/restapi/compare/v0.24.0...v0.25.0
[0.24.0]: https://github.com/rapidmx/restapi/compare/v0.23.0...v0.24.0
[0.23.0]: https://github.com/rapidmx/restapi/compare/v0.22.1...v0.23.0
[0.22.1]: https://github.com/rapidmx/restapi/compare/v0.22.0...v0.22.1
[0.22.0]: https://github.com/rapidmx/restapi/compare/v0.21.1...v0.22.0
[0.21.1]: https://github.com/rapidmx/restapi/compare/v0.21.0...v0.21.1
[0.21.0]: https://github.com/RapidMX/restapi/compare/v0.20.1...v0.21.0
[0.20.1]: https://github.com/RapidMX/restapi/compare/v0.20.0...v0.20.1
[0.20.0]: https://github.com/RapidMX/restapi/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/RapidMX/restapi/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/RapidMX/restapi/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/RapidMX/restapi/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/RapidMX/restapi/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/RapidMX/restapi/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/RapidMX/restapi/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/RapidMX/restapi/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/RapidMX/restapi/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/RapidMX/restapi/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/RapidMX/restapi/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/RapidMX/restapi/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/RapidMX/restapi/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/RapidMX/restapi/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/RapidMX/restapi/compare/v0.4.0...v0.6.0
[0.4.0]: https://github.com/RapidMX/restapi/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/RapidMX/restapi/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/RapidMX/restapi/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/RapidMX/restapi/compare/v0.1.0...v0.2.0
