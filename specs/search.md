# RapidMX: Search Under Zero-Access and End-to-End Encryption

Companion to `end-to-end_encryption.md` (referred to below as `e2e_tdd.md`). This document specifies how search functions once message content is unreadable to the server — whether because the sender encrypted it end-to-end, or because RapidMX encrypted it at rest on arrival.

> **Revision note.** An earlier draft assumed the server retained plaintext for the majority of mail and tiered only the encrypted minority. The adoption of zero-access encryption (§3) inverts that, and the server-built encrypted index (§7) replaces the client-built index and the server-assisted candidate narrowing that the earlier tier model relied on.

## 1. Current Architecture

Established by reading `search/` in the REST API. Recorded here as the baseline the design must preserve or consciously degrade.

**Provider abstraction.** `SearchProvider` exposes `index`, `bulkIndex`, `remove` and `search`, selected via the `search:provider` config key. Three implementations exist: `MongoTextSearchProvider`, `PostgresFullTextSearchProvider` (tsvector/GIN) and `OpenSearchProvider`. Indexing is eventually consistent with the primary datastore via `SearchIndexState` and `SearchIndexJob`.

**Document shape.** `SearchDocument` is a flattened, provider-agnostic projection covering five entity types — `message`, `contact`, `calendarEvent`, `note`, `task` — with fields `subject`, `body`, `attachmentText[]`, `participants[]` and `dateForSort`, scoped by `mailboxUid`.

**Query model.** `SearchQuery` is `{ mailboxUid, text, entityTypes?, limit?, cursor? }`. There is no field-operator grammar. Postgres uses `plainto_tsquery`, OpenSearch uses `multi_match`. Search is bag-of-words relevance ranking, not structured query.

**Ranking.** Both providers weight fields, and they agree on the ordering:

| Field | Postgres weight | OpenSearch boost |
| --- | --- | --- |
| `subject` | A | ×3 |
| `participants` | D | ×2 |
| `body` | B | ×1 |
| `attachmentText` | C | ×1 |

**Pagination** is offset-based. Both providers encode an integer offset in the opaque `cursor` and detect `hasMore` by requesting `limit + 1`.

**Attachment text** is extracted server-side by `AttachmentExtractionJob` via `ExtractorRegistry`, dispatching on MIME type to plain-text, HTML, PDF and DOCX extractors, with a 25 MB size cap and a 30-second timeout. The job is explicitly asynchronous and never runs inline on ingestion, so that extraction cannot delay SMTP-ACK.

**`SearchResult.snippet`** is declared in the interface as provider-generated highlight text. `OpenSearchProvider.search()` does not currently populate it.

## 2. Two Kinds of Unreadable

Content becomes unreadable to the server by two different routes, and they have different consequences for search.

| | **Zero-access** | **End-to-end** |
| --- | --- | --- |
| Encrypted by | RapidMX, on arrival | The sender |
| Server saw plaintext | Yes, during the delivery transaction | Never |
| Covers | All mail, by policy | The minority with a key exchange |
| Server can index | **Yes**, at delivery | No |
| Guarantee | Implementation and policy | Cryptographic |

This distinction is the hinge of the whole design. **Zero-access content is indexable at the one moment the server legitimately holds it**, which is what makes a prebuilt, server-generated index possible. End-to-end content never passes through the server in the clear, so only a client can index it.

For either kind, these `SearchDocument` fields become unavailable to a server-side query:

| Field | Available after encryption |
| --- | --- |
| `entityType`, `entityUid`, `mailboxUid` | Yes — routing metadata |
| `dateForSort`, `participants`, `folderUid`, `flags`, `hasAttachments` | Yes — required for listing and delivery |
| `subject` | No — under RFC 9788 header protection it sits inside the encrypted structure |
| `body` | No |
| `attachmentText[]` | No |

**Server-side relevance ranking collapses in both cases.** Of the weighted fields, only `participants` survives — weight D in Postgres, ×2 in OpenSearch. Every high-signal field is gone, so a server-computed score over encrypted mail is not comparable to anything and MUST NOT be presented as relevance.

## 3. Zero-Access Encryption

End-to-end encryption protects only the fraction of mail where both parties hold keys. Everything else — the invoice, the newsletter, mail from every correspondent who will never run RapidMX — sits in the mailstore in plaintext. Zero-access encryption closes that gap.

### Mechanism

At delivery (`POST /internal/mta/deliver`), after spam filtering and after the archive journal, the server:

1. Builds a sealed **index entry** for the message (§7) — extracted subject, body text, attachment text and envelope fields, encrypted to the mailbox's zero-access public key.
2. Encrypts the full original MIME to the mailbox's zero-access **public** key, as a standard S/MIME message (CMS `EnvelopedData`, ECDH P-256, AES-256-GCM).
3. Encrypts the subject and preview into a small sealed summary, so the message list can render without fetching the body.
4. Discards the plaintext.

Asymmetric encryption is what makes this possible: the server can encrypt without holding anything that can decrypt.

### Zero-Access Key

Each mailbox has a **dedicated zero-access keypair** (`useType: "zero-access"`), separate from its signing and E2E encryption keypairs. It is generated on the client at key setup alongside the others, its certificate is issued by the internal CA (so CMS can address it), and its private key is wrapped under the mailbox master key (MK) exactly like the other private keys in `e2e_tdd.md`. Existing users with a vault but no zero-access key provision one automatically on their next unlock.

The zero-access key is **never published** — it is excluded from the discovery endpoint and from the `RapidMX-Key` header. Correspondents encrypt to the E2E encryption key; only this server encrypts to the zero-access key.

Keeping it separate from the E2E encryption key means rotating either key never touches the other's ciphertext, and a delegate can be given the zero-access key (§3 *Shared Mailboxes*) without being able to read the owner's end-to-end mail. On rotation the old private key is retained, so existing messages and index segments stay readable without re-encryption.

Because the stored form is ordinary S/MIME, a user can export their zero-access key (together with their E2E encryption keys) as a PKCS#12 file and install it in Outlook or a phone's mail app, which then decrypt zero-access mail natively over ActiveSync.

### What It Is Not

**Zero-access is not end-to-end encryption and MUST NOT be described as such.** The server holds the plaintext for the duration of the delivery transaction and is trusted to encrypt it and discard the original. That is an implementation and policy guarantee, not a mathematical one.

It defeats mailstore theft, backup exposure, a rogue administrator browsing storage, and most subpoenas for data at rest. It does not defeat a compromised or malicious server at the moment of delivery.

Product documentation MUST state this distinction plainly, in the same terms as the escrow disclosure rule in `e2e_tdd.md`. The Message Security Indicators table there requires a state distinct from both *Encrypted* and *Unprotected*.

### Policy States

Zero-access is controlled by two settings:

| Setting | Scope | Default | Who changes it |
| --- | --- | --- | --- |
| **Allow zero-access encryption** (`EncryptionPolicy.allowZeroAccess`) | Server-wide | On | Administrator |
| **Enable zero-access encryption** (`Mailbox.zeroAccessEnabled`) | Per mailbox | On | Mailbox owner only |
| **What to protect** (`Mailbox.zeroAccessTypes`: mail, calendar, contacts, tasks) | Per mailbox, per data type | Depends on the user's devices — see *What It Covers* | Mailbox owner only |

Zero-access is **active** for a data type of a mailbox when the global setting allows it, the mailbox setting enables it, the mailbox's `zeroAccessTypes` includes that type, **and** the mailbox has a zero-access key enrolled. When any of the three is false, mail is stored exactly as before zero-access existed: plaintext at rest, full server-side content search.

When the administrator turns the global setting off, the mailbox setting is shown disabled with an explanation that the administrator has disabled it. Administrators MUST NOT be able to change the mailbox setting — their only lever is the global switch, which is visible to every user. Turning zero-access off never decrypts anything (the server cannot); only mail arriving afterwards is stored in plaintext.

When zero-access becomes active for a mailbox that already holds plaintext mail, a background backfill indexes, encrypts and discards that mail, so the guarantee covers the whole mailbox rather than only mail received after enablement.

The settings exist because zero-access has real costs beyond search, which the prebuilt index does not recover:

- **Server-side rules matching on body text** cannot be evaluated after delivery. Header and envelope rules are unaffected. Rules that must match on body text MUST be evaluated in the delivery path, before encryption, or not at all.
- **Archive and compliance search** operates on ciphertext. Recoverable only through the escrow scope that covers the mailbox.
- **Retrospective antivirus rescanning** of stored attachments is not possible. Scanning at delivery is unaffected.

### What It Covers

Zero-access protects four data types, each switched on or off separately by the mailbox owner. A type that is on is sealed field by field (`sealedFields`, one CMS `EnvelopedData` per field, with a placeholder in the readable column) on every write, whoever writes it: the web client, ActiveSync, Outlook (MAPI), a plugin, or the server itself creating a contact. The same rule as for mail applies: plaintext may pass through a request, and is sealed before it is stored.

| Data type | Encrypted | Stays readable by the server, and why |
| --- | --- | --- |
| Mail | Body, subject, preview, attachments | Sender, recipients, dates, size, flags, folder: needed to deliver, thread, enforce quota and search by envelope. |
| Calendar | Title, location, description | Start, end, time zone, recurrence, organizer and attendee addresses and names, responses, busy status, the out-of-office auto-reply text: needed for free/busy, invitations, reminders' timing and automatic replies. |
| Contacts | Names, company, job title, phone numbers, postal addresses, notes, categories, the labels of email addresses, photo | **Email addresses**: the server needs them to deliver mail, to find and pin each contact's encryption keys, to tell known senders (Focused Inbox) and to suggest contacts. Favorite flag and folder. |
| Tasks | Title, notes | Due date, reminder time, priority, completion, list, My Day. |
| All types | | Folder, calendar and list names; how many items there are, how large, and when they change. |

**Email addresses are deliberately not encrypted.** They are what mail is routed by, the key every end-to-end encryption key is pinned and looked up under, and how incoming mail is matched to a contact. Encrypting them would break end-to-end encryption and Focused Inbox, and protect little: the addresses of everyone a mailbox exchanges mail with are already visible to the server in the mail's own headers and kept in its correspondents list.

**Protected types and other devices.** ActiveSync phones and Outlook have no way to read a zero-access calendar, contact or task, and can read zero-access mail only after the user installs their exported keys. For a protected type they still sync each item, with placeholders: an event is a busy block named "Protected event", a contact shows only its email addresses, a task is "Protected task", a message is S/MIME the device can open only with the exported key. Edits made on a device are sealed on arrival; a placeholder sent back unchanged is ignored and never overwrites the protected value. A device sends back the empty placeholders it was shown, so the device services must leave out a protected field the device didn't change. An empty value (`null`, `[]`) is therefore never taken as a clear on its own, from any client: a client that couldn't open the item (its keys locked, a delegate without the mailbox's key, a REST tool echoing what it read) sends back the same empty placeholders, and must not wipe what it never saw. A RapidMX client that opened the item clears a field by sending it empty **and** naming it in the request's `clearedFields` list (never stored); it names only a field that held a value when it opened the item and that the user emptied. The first write of an item while its type is protected seals all of it, not only the fields it carries: whatever was still readable (an item the backfill hadn't reached yet, one moved in from a mailbox that doesn't protect the type, a field edited while the type was off), a contact's photo included. An item with protected content can't be moved to another mailbox: it is sealed to its own mailbox's key, which the server can't change. The client copies it there instead.

**Defaults follow the user's devices.** When zero-access is turned on for a mailbox whose owner syncs with ActiveSync or Outlook, the types those clients use default to **off** so the device keeps working — mail stays on only if the user has exported their keys. Without such a client, every type defaults to on. The owner can switch any type on regardless; each switch states plainly what it will break on which device. A device first connected after a type was protected raises a notice in settings; nothing is switched off automatically. The activesync and mapi services record which clients they serve on the mailbox (`Mailbox.syncClients`) for this.

A protected contact shows its first email address in place of its name, and keeps every address readable (labelled "other"; the labels are sealed with the list). Its photo is stored sealed and served as opaque bytes the client opens. Contacts the server creates itself — from a key lookup, a trusted signer, a key header, or a suggestion from correspondence — hold only an address and the name the mail carried, which the correspondents list keeps readable anyway; they are sealed the first time the user edits them.

Turning a type off never decrypts anything. Items written afterwards are stored readable; an existing protected item stays protected until it is next edited. Turning a type on starts a background backfill of that type's existing items.

**Calendar invitations** for a protected calendar are composed and handed to the outbound mail path while the server still holds the plaintext of the save request, so attendees receive ordinary invitations while the stored event is sealed. Reminders carry only the event and its time; the client shows its own decrypted title. The same holds for an event filed from a zero-access invitation, whose content is sealed whole (`sealedContent`): the scheduling job never invites for it, and a save of a meeting the mailbox organizes invites from the content the client opened. A client that couldn't open such an event writes back its placeholders, which leave the sealed content as it is; a new location or description sent with the placeholder title is refused (409), since resealing would lose the title. The server can't compare such an event's location with the one a save sends, so a save does not raise the event's sequence for it; the client that opened the event raises the sequence itself when it changes the location, and any other sequence it sends is ignored.

- **What the client sends.** A save of a protected event sends only the fields that changed, plus `invitationContent` — the event's full title, location and description in plaintext — whenever the change needs the attendees told. The server builds the invitation from it, sends it, records the sequence as sent, and stores the content sealed. `invitationContent` itself is never stored.
- **Without it,** the save still succeeds but no invitation goes out; the change stays pending (the server logs it) until a save that carries the content. The background scheduling job never sends an invitation for a protected event, because all it could send is the placeholder.
- **Deferring.** A create can hold its invitations back for the save that follows by sending `invitationContent: { defer: true }`. The event editor does this when it attaches a video meeting right after creating the event, so attendees get a single invitation, the one with the link. A save that sends invitations answers with the event as stored afterwards, including the version that recording the sent sequence wrote.
- **Sent by the organizer's client.** An event whose organizer sends its invitations encrypted (`encryptionOrigin: "originated"`) is recorded as sent and never mailed by the server, as the scheduling job does.
- **Replies and change requests** to a protected invitation are named by the `invitationContent` the attendee's client sends; this covers an event filed from a zero-access invitation too. Without it they name no title, rather than the placeholder.
- **Change requests and accepted proposals.** A guest's request to change a protected or keyed meeting is never applied by the server: the scheduling job can't invite for it, so the request stays a proposal. The organizer's client accepts a proposed time with `invitationContent` (and the guests' `meetingLinkSecrets` for a keyed meeting), and the server sends the updated invitations then; without them the accept is refused and nothing moves.
- **Cancellations** of a protected event go out with the placeholder title ("Protected event") — the attendees already have the real one from the invitation.
- **Incoming invitations** are filed sealed into a protected calendar even when the mail that carried them isn't zero-access.
- **Meetings with external guests.** A video meeting with someone outside RapidMX is protected by a temporary per-meeting key (meet-plugin `specs/meeting_privacy.md`). Each guest's join link carries the key after `#`, supplied by the organizer's client as `invitationContent.meetingLinkSecrets` on every save that invites, and never stored. Such invitations are likewise sent only at save time. A guest whose copy would be stored on this server readable (a mailbox here whose mail isn't zero-access, or an address of this server's domains that isn't a mailbox) gets no keyed invitation. A reply or a proposal this server composes for a guest (`REPLY`, `COUNTER`) never carries `LOCATION`, so a guest's keyed link can't travel back to an organizer whose copy is stored readable; a change request carries one only when it asks to move the meeting there. A reply composed by another client (an external guest's Outlook) may still echo the keyed link, which this server can't prevent.
- **ActiveSync.** A meeting a phone creates in a protected calendar is sealed on arrival and its invitations are sent then, from what the phone sent. A change made on a phone is sealed too, but sends nothing: the phone sends back the placeholders it was shown, so the server has no full content to invite with. The change reaches attendees the next time the meeting is saved in RapidMX.
- **Outlook (MAPI).** An event Outlook saves into a protected calendar is sealed, and Outlook's meeting invitations for it are not sent: Outlook sends them after saving, from the stored event, which then holds only placeholders. Send meeting invitations from RapidMX instead, or leave the calendar out of zero-access.
- **Plugins.** The booking plugin seals the event it puts on a protected calendar, and composes the invitation it mails the booker from the booking itself. The booking record keeps the booker's name, notes and location readable: the booking page and the host's booking list need them.

### Ordering Within the Delivery Path

The sequence is load-bearing and MUST be:

```
SMTP accept → rspamd → archive journal → index → encrypt → store → discard plaintext
```

Spam filtering and archiving both require plaintext and both precede encryption. Indexing must precede encryption for the same reason. Any step that needs plaintext and is not in this list must either join it or move to the client — **a plaintext spool outside this transaction defeats the entire property** (see §9).

For zero-access recipients this whole sequence runs **inside the ingest request**, before the server acknowledges the message to the MTA. The asynchronous scan queue, which spools the raw message to blob storage first, is used only for recipients without zero-access. A transient failure while processing a zero-access recipient returns a temporary SMTP failure (451) so the MTA retries from its own queue; the server never parks plaintext to retry later. Bridges that stage inbound mail (e.g. SES via S3) MUST delete the staged copy once the server accepts it.

### Every Write, Not Just Delivery

The rule generalises: **the server may see plaintext inside a request, but MUST NOT persist it for a zero-access mailbox.** This covers every path that files message content — inbound delivery, rule copies, quarantine, the Sent Items copy after relay, scheduled send, drafts, mailbox import, ActiveSync and MAPI submissions, and plugins that file mail. All of them go through one filing helper that chooses sealed or plaintext storage.

Drafts are sealed on save. Because the server can no longer read a stored draft, the client assembles the MIME and supplies the plaintext again at send time. A draft's attachment rows are its working attachments: sealing it (on save or by the backfill) keeps them, readable until it is sent, and only drops their extracted text.

A send waits in Outbox readable until it is relayed. One that can no longer go ahead - it failed for good, or was relayed but its Sent copy was never filed - is sealed by the backfill: as a draft when it was never relayed (retrying it then answers 409, and the client assembles it again), as sent mail when it was.

Server-side mailbox import (`POST /mailbox-import-requests`) is refused (409) for a mailbox whose mail is zero-access: the uploaded PST or mbox would wait in the blob store as a readable archive until `MailboxImportJob` runs, a plaintext spool outside the request. Such a mailbox's archive can only be imported by a client that seals each message. An import queued before zero-access was turned on is still sealed message by message (`sealRaw`), and its archive deleted once it ends.

The server-side search index (`SearchIndexJob`) holds only metadata for a zero-access mailbox's mail: a sealed message's, and also a message still stored readable in such a mailbox (a draft assembled for sending, waiting in Outbox or moved back to Drafts, or mail the backfill hasn't reached), under the placeholder subject with no body or attachment text, whatever cleared its index stamp. A send's move into Outbox (queued, scheduled or claimed) clears the stamp as any folder move does, so a readable document the draft still had (one indexed before the mailbox turned zero-access) is replaced then rather than when the sealed Sent copy is filed. That metadata document replaces any readable one the provider still holds, so it is retried until it is written; when its retries run out the old document is removed instead (and retried while even that fails). The indexer otherwise leaves deleted mail alone, but it takes sealed deleted mail with a cleared stamp in what is left of each batch, so a readable document that outlived the message's deletion is replaced the same way; the backfill also removes the document of restorable deleted mail it seals at once. The attachments of a sealed draft are never text-extracted, nor marked as done: they are extracted once the draft is stored readable (zero-access turned off) and sent with them.

The subject and preview of a zero-access message are replaced on the server by a placeholder and carried only in the sealed summary. Derived server data — push notification payloads, the mail event stream, contact enrichment — carries envelope fields only. A `message.delivered` event for a zero-access copy says so (`zeroAccess: true`) and carries no subject and no report parsed from the body (a bounce's or complaint's details), so a plugin can't handle a bounce that reaches a zero-access mailbox. Notices the server composes about a zero-access message never quote the placeholder: a recall goes out as `Recall`, naming the message by the time the server relayed it, and a read or delivery receipt as `Read receipt` or `Delivery receipt`; recipients still match them by `X-RapidMX-Recall-Of` and `Original-Message-ID`.

### Shared Mailboxes

A shared mailbox is either **ownerless** (e.g. `support@`) or an owned mailbox with **delegates**. Neither has a single password that every member knows, so members cannot unlock it through MK.

Instead, the mailbox's zero-access **private key** — never its MK, signing key or E2E keys — is wrapped to each member's own zero-access certificate. A member unlocks their own mailbox, then unwraps the shared mailbox's key. Delegation therefore grants the ability to read, not the owner's identity.

- **Provisioning.** The owner's client provisions an owned mailbox. For an ownerless mailbox, a member with full access provisions its keypair, and the member wraps (plus an escrow wrap, if the mailbox has an escrow scope) are its only copies.
- **Grants.** Adding a member — including by an administrator, who holds no key — creates a pending grant. Any unlocked member who holds the key fulfils it in the background. A member without a zero-access key of their own stays pending until they first sign in.
- **Revocation.** Removing a member triggers a key rotation on the next unlocked member's client: a new keypair is enrolled for new mail, and the retained old keys are re-wrapped for the remaining members only. Until that runs, new mail is still encrypted to the old key; the client shows the rotation as pending.
- **Interface.** All of this is under `/mail/mailboxes/:id/keyvault`.
  - `GET members` reports the members, their certificates and wraps, and who is pending or departed, with the caller's `role`.
  - `GET member-wraps` returns the caller's own wraps.
  - `PUT member-wraps` fulfils grants; it is for the owner and members with full access.
  - `DELETE member-wraps/:user` removes a departed user's wraps.
  - `POST shared-zero-access-key` serves a mailbox without an owner: its key and the members' wraps are written together.
  - A member's "own certificate" is the active zero-access key of a mailbox they own.
  - Membership is read from the access list uncached.
  - Retained keys need no re-wrapping on rotation: the remaining members already hold them. Only the departed user's wraps are removed.
  - A vault holds at most 2000 member wraps of any one key and 10,000 in all. The bound is per key because the earlier keys' wraps stay after each rotation. Members times retained keys reach the total after about 10,000 / members rotations, so a rotation whose members' wraps wouldn't fit is refused (400) before its certificate is issued, for an owned mailbox and an ownerless one alike: the current key stays active rather than leave new mail sealed to a key no member can be given.
- **Owner.** A mailbox without an owner can't be given one (409) while any of its zero-access keys has no copy in its vault under a master key: a key provisioned while it had no owner has only member and escrow wraps, which an owner (who opens keys through their MK) never reads. Keys an owner enrolled before being removed stay in the vault under that owner's MK, so such a mailbox can be given an owner again; giving it to the right person is the administrator's to check, as for any owner change.
- **Escrow.** An owned mailbox's keys are opened by its escrowed MK. A mailbox without an owner has no MK, so each of its zero-access private keys is wrapped straight to its escrow scope's certificate (`KeyVault.zeroAccessEscrowWraps`).
  - `POST shared-zero-access-key` requires `escrowWrap` while the mailbox is assigned to a scope, written in the same transaction as the key.
  - `PUT escrow-wraps` (full-access members) adds the copies a scope is missing: keys provisioned before the mailbox was assigned, or under an earlier scope. `GET members` reports them as `escrowPending`, and an unlocked member's client fills them in the background.
  - Each wrap must be CMS addressed to the scope's certificate. An escrow release (`/material`) carries the wraps for the matter's scope, whether or not the mailbox has an owner now.

## 4. Encryption Scope

Encryption is scoped by **provenance**, not by entity type and not by the correspondent's stated preference.

| Entity type | Encrypted? |
| --- | --- |
| `message` | Yes, per the E2E policy. |
| `calendarEvent` | When materialised from an encrypted message received from a federated peer or external sender, **or** when the user originates an invitation sent over an encrypted channel (any tier). |
| `contact` | Never end-to-end. See below. (At rest, contacts are protected by zero-access encryption when the owner includes them — §3 *What It Covers*.) |
| `note`, `task` | Only when user-created from encrypted content, and only with explicit warning. |

The majority of calendar events — user-created and sent unencrypted, internal invitations, and invitations from unencrypted external senders — remain plaintext and are served entirely by Source A at existing fidelity, content included.

### Rationale: Sender Privacy, Not Recipient Privacy

The protected interest is the **external sender's**, not the recipient organisation's internal privacy.

When an external party sends an encrypted meeting invitation, they encrypted it because RapidMX told them it was end-to-end. If the recipient's client then materialises a `calendarEvent` with a plaintext subject, attendee list, location and agenda into `mail_search_index`, the sender's content has reached server-visible storage through a side door — a different store from the mailbox, with its own backups, replicas and possibly a managed service.

The sender cannot see the recipient organisation's configuration. Allowing that configuration to silently determine whether their content is indexed in plaintext makes the meaning of "end-to-end" depend on a setting they have no visibility into.

This does not extend to same-organisation mail *by default*. Where both parties are inside one administrative boundary, the administrator can already read the mailbox, and indexing a derived event leaks nothing new. **Automatic** derived-entity protection therefore applies only to content originating from a federated peer or external sender.

**Inheritance, however, follows the message's actual encryption state, not its tier.** If a message arrived encrypted — for any reason, including a same-organisation sender who chose to encrypt — its derived entities are encrypted. Tier scoping governs only whether protection is applied *automatically*; it MUST NOT govern whether existing protection is inherited.

Without this distinction, an internal sender's deliberate encryption is silently undone on the receiving side. The motivating case is privileged communication: counsel encrypts an internal invitation, the recipient's client materialises the event, and a tier-based rule would index its title in plaintext.

### Contacts Are Never Encrypted End-to-End

This section is about end-to-end provenance: a contact never inherits encryption from a message. It is independent of zero-access encryption, which protects a contact's details at rest when the owner includes contacts (§3 *What It Covers*); that protection never extends to email addresses.

A contact is a record the user authored about another person. The correspondent never sent it and has no expectation about it. `prefer-encrypt=mutual` is a statement about messages in transit, not about the recipient's address book, and MUST NOT be interpreted as retroactively changing how an existing contact is stored.

To eliminate the mixed-provenance case entirely — a record whose display name was typed by the user but whose phone number was scraped from an encrypted signature block — **contacts MUST NOT be auto-enriched from encrypted message content.**

- Address and display name MAY be taken from the envelope, which the server already processes for delivery.
- Signature-block parsing, phone number extraction, title inference and any other enrichment derived from decrypted body content MUST be skipped for encrypted messages.

With this rule, no contact ever contains encrypted-derived content, field-level provenance tracking is unnecessary, and contacts remain fully searchable in Source A.

### Originated Encrypted Events

A user MUST be able to originate an encrypted calendar invitation, not merely receive one. Without this, no RapidMX user could ever produce encrypted calendar content and the receive path would be unreachable in practice.

**An event's encryption state follows the message that carries it, in both directions.** When an invitation is sent encrypted, the organiser's own copy of the event MUST be encrypted. This is the encrypt-to-self rule from `e2e_tdd.md` applied to calendar: without it, the organiser's Calendar holds in plaintext exactly what the invitation protected.

This refines the external-only scoping above. Automatic protection is scoped to external senders, but an **explicit user choice to encrypt MUST be honoured regardless of tier**, including for same-organisation invitations. A deliberate decision outranks a default.

### Field Split

Encrypted calendar events are partially encrypted.

| Field | State |
| --- | --- |
| Title | **Encrypted** |
| Notes / description | **Encrypted** |
| Location | **Encrypted** |
| Attachments | **Encrypted** |
| Start, end, duration, busy status, recurrence pattern | Plaintext |
| Attendee list and RSVP status | Plaintext |
| Organiser | Plaintext |

**Temporal fields stay plaintext** because free/busy is a same-organisation disclosing capability served by the server, and an encrypted event must still block time. Free/busy responses MUST report busy time without title or location.

**Attendees stay plaintext** because the list is already server-visible. A meeting invitation travels as an ordinary message whose `To:` and `Cc:` headers name every attendee, and RFC 9788 retains outer headers by default so that clients without header-protection support can still render the message. Encrypting the attendee list inside the derived event would protect a copy of data the receiving server already holds, while breaking RSVP tracking, delegate access, room booking and "who hasn't responded" — all of which are server-side functions.

Two residuals are recorded rather than acted on:

- **RSVP status is not derivable from the original headers.** Who accepted or declined accumulates after the invitation is sent. It is retained in plaintext because scheduling requires it server-side, and its sensitivity is low relative to the attendee list itself.
- **This decision depends on outer headers being retained.** If RapidMX later adopts RFC 9788 HP-Obscured handling for encrypted mail, stripping or obscuring outer `To` and `Cc`, the attendee list would cease to be server-visible and this rule MUST be revisited.

This split preserves `dateForSort` and `participants`, so date-range and attendee search over encrypted events continue to work in Source A. Only title, notes, location and attachment text require a segment.

### Lifecycle

Encryption state is sticky for the life of the event.

- Updates and cancellations MUST use the same encryption state as the original invitation. An encrypted invitation followed by a plaintext update discloses the subject regardless.
- For a recurring series, all instances and exceptions MUST share one encryption state.
- Adding an attendee who cannot receive encrypted mail is the multi-recipient case from `e2e_tdd.md`: the client MUST NOT split the event into encrypted and plaintext copies. It MUST present the user the choice of sending the whole event unencrypted or removing that attendee.
- Transitioning an existing plaintext event to encrypted MUST re-encrypt the stored event **and** remove its content fields from the server-side index. Transitioning in either direction MUST be an explicit user action, never automatic.

### Provenance

Encrypted derived and originated entities carry an origin marker governing behaviour on edit, update and duplication. It is not a security control — ciphertext is self-evident to the server — but it determines which operations preserve encryption.

```ts
export type EncryptionOrigin =
    /** Not encrypted. */
    | "none"
    /** Materialised from an encrypted message received from a federated peer or external sender. */
    | "derived"
    /** Encrypted by explicit choice of this user. */
    | "originated";
```

It MUST be a denormalised field on the entity, not a reference to the source message. A user routinely deletes an invitation email while keeping the meeting; a join would break, a copied value does not.

`derived` and `originated` MUST remain distinguishable. The UI MUST be able to explain *why* an item is encrypted — "received encrypted from bob@orgb.com" versus "you chose to encrypt this" — because an unexplained lock icon reads as a defect.

**Inheritance:**

| Operation | Inherits encryption |
| --- | --- |
| Edit (any field) | **Yes** — editing a title must not leak what the original protected |
| Meeting update / cancellation | **Yes** |
| Series exception from an encrypted master | **Yes** — an exception is part of the series, not a new event |
| Drag to a new date / time | **Yes** |
| Duplicate, "copy to", use as template | **No** — a new meeting is a new meeting |
| New event from scratch | **No** |

Duplication deliberately does not inherit: the user makes an explicit choice for the new event. Because this is a downgrade path, the encryption toggle in the compose UI MUST default to **on** when the source event is encrypted. The choice remains the user's; the default must not make the leaky path the lazy one.

The distinction between a series exception and a duplicate MUST be enforced at the model level. Exceptions are frequently implemented through the same code path as duplication, which is how this rule gets broken by accident.

Changing encryption state on an existing entity MUST be an explicit user action with a warning, and downgrading MUST re-index the content fields server-side.

### Requirements

- Entities materialised from an encrypted external message MUST carry a provenance flag.
- Such entities MUST NOT have `subject`, `body` or `attachmentText` indexed in Source A. They are indexed on the reduced field set of §2, with content reaching the index only through a segment.
- Files saved out of encrypted attachments MUST NOT be submitted to `AttachmentExtractionJob`.
- User-initiated derivation (creating a note or task from an encrypted message) MUST warn that the new entity will be stored unencrypted unless provenance handling is applied.
- This behaviour MUST be an administrator setting, **defaulting to protective**, so that a compliance-driven organisation disables it deliberately rather than acquiring it by accident.

### Administrative Recovery

Derived encrypted entities are encrypted under the same mailbox master key (MK) as messages, so the organisational escrow mechanism in `e2e_tdd.md` covers them with no extension. An administrator with the escrow key can decrypt both mail and derived calendar events.

Escrow is optional and disabled by default. An organisation that has not enabled it cannot recover either messages or derived events. Product documentation MUST state that escrow is *available*, not that administrators can always decrypt.

### Legal Note

Retention regimes such as SEC 17a-4, FINRA and HIPAA generally permit encryption provided records remain producible in readable form, which is the purpose escrow serves. GDPR Article 32 pulls the other way, naming encryption as an appropriate technical measure on a risk basis. None of them grant a correspondent authority over how the receiving organisation stores its own records, which is why derived-entity handling is an administrator decision.

This summary is not legal advice and MUST NOT be reproduced as a compliance claim in product documentation without review by counsel.

## 5. Threat Model

The design must not increase what the server learns beyond what it already knows in order to accept and route mail.

**The server already knows,** and may continue to use for search: envelope participants, dates, message sizes, folder placement, flags, and — for zero-access mail, during the delivery transaction only — the full plaintext.

**The server must not learn:** any token, term or n-gram derived from plaintext *after* the delivery transaction has completed; which term a user searched for; or which specific messages matched a query.

**Index entries and segments are opaque to the server.** The server writes a sealed entry during delivery and never holds a readable index afterwards. It observes only entry and segment sizes and the delivery cadence it already knows.

### The Trust That Zero-Access Adds

A server-built index requires one trust the earlier client-built design did not: **the server is trusted to index honestly.** A malicious server could omit entries, making messages unfindable while leaving them readable, or inject entries that match queries they should not.

This is a *different* trust, not a strictly larger one. The same server already holds the plaintext at delivery and could simply retain it. A client has no way to verify a server-built segment short of decrypting every message and reindexing, which is the cost the design exists to avoid.

The property MUST be stated rather than assumed. Deployments that cannot accept it disable zero-access and fall back to client-built segments for all content.

**Out of scope:** an adversary who compromises an unlocked client. Segments are plaintext once decrypted, and a compromised device exposes the mailbox regardless.

## 6. Rejected: Deterministic Encrypted Keyword Index

Restated because it is the design most likely to be reproposed, and because the prebuilt segment design can be mistaken for it.

Hashing tokens and uploading them for server-side matching MUST NOT be used.

- **Frequency analysis.** Natural-language word frequencies are public, so the hash distribution maps back onto the word distribution with high accuracy. A per-user HMAC key prevents cross-user correlation but not within-user analysis.
- **Query and access-pattern leakage.** The server learns which hash was queried and which messages matched — the basis of most practical attacks on searchable encryption.
- **It does not restore ranking.** Token hashes give term presence, not the field weights that produce the relevance ordering.

**The segment design is not this.** A segment is a conventional plaintext index encrypted as an opaque blob. The server cannot query it, match against it, or learn anything from a search — because searching happens entirely on the client, after decryption. The server's only role is building the segment at the moment it legitimately holds plaintext, and storing the ciphertext afterward.

## 7. Architecture: Server-Indexed Encrypted Segments

The server extracts and indexes content at the one moment it legitimately holds plaintext — during delivery — then encrypts the result. Clients download it, decrypt it, and search locally. The expensive work (MIME parsing, HTML stripping, attachment text extraction) happens once, on the server, instead of once per device on hardware that cannot afford it.

```
   DELIVERY (server, plaintext in hand)          QUERY (client, after unlock)

   message ──┬──► sealed index entry             ┌──────────────────────────┐
             │    (current week)                 │   Client query engine    │
             └──► encrypt to mailbox             └───┬──────────┬───────┬───┘
                  zero-access pubkey                 │          │       │
                        │                ┌───────────▼──┐ ┌─────▼────┐ ┌▼──────────┐
                  discard plaintext      │ A. Metadata  │ │ B. Zero- │ │ C. Client │
                                         │   (server)   │ │  access  │ │ segments  │
   CLOSED WEEK (any unlocked client)     ├──────────────┤ │ entries +│ ├───────────┤
                                         │ envelope,    │ │ segments │ │ true E2EE │
   week's entries ──► FTS5 segment       │ folder,flags,│ │          │ │ content   │
     ──► seal to pubkey ──► upload       │ unencrypted  │ │          │ │           │
                                         │ entities     │ │          │ │           │
                                         └──────────────┘ └──────────┘ └───────────┘
```

### Source A — Server-side metadata index

The existing `SearchProvider` stack, unchanged in shape. It indexes:

- Envelope and state fields for **every** message, encrypted or not: `from`, `to`, `cc`, `dateForSort`, `folderUid`, `flags`, `hasAttachments`, `attachmentNames[]`, `attachmentExt[]`, `attachmentTypes[]`.
- Full content for every entity type that is **not** encrypted — contacts always, and calendar events, notes and tasks outside the provenance rules in §4.

No changes to `MongoTextSearchProvider`, `PostgresFullTextSearchProvider` or `OpenSearchProvider` are required beyond the schema additions in §17.

Source A is also **the authority on current state**. See *Mutations* below.

### Source B — Zero-access entries and segments

The content index for all zero-access mail.

- **Index entries.** At delivery the server writes one **sealed index entry** per message: the extracted subject, body text, attachment text and envelope fields, as a small record encrypted to the mailbox's zero-access public key. The server never holds an index it can read after the delivery request completes.
- **Segments.** Once a week has closed, an unlocked client device **compacts** that week's entries into a **SQLite FTS5 database file**, encrypts it to the same public key, and uploads it. Every other device then downloads that one file instead of the week's individual entries.

The server cannot build or update a segment itself: appending to a segment requires reading it, and a segment the server can read is a plaintext index at rest. Splitting the work this way keeps every expensive step on the server while the plaintext is legitimately in hand, and leaves the client only a cheap insert of already-extracted text.

The segment file format is stable and endian-independent, so one schema serves web, desktop and mobile. Entries use the same row schema as segment rows.

### Source C — Client-built segments

For true end-to-end encrypted content, which the server has never seen and cannot index. The client builds these after decryption, in **the same format as Source B**.

Client-built segments MUST be encrypted and uploaded to the segment store. They are then available to the user's other devices, so E2EE content is indexed once per mailbox rather than once per device. The server stores ciphertext and learns nothing beyond segment size.

This unification is what retires the previous design's server-assisted candidate narrowing: there is no longer a class of content reachable only by fetching and decrypting whole messages.

### Segment Model

**The index is time-sharded by week.** A single monolithic index would have to be re-encrypted and re-downloaded in full on every arriving message. Sharding bounds both.

| | Current week | Closed weeks |
| --- | --- | --- |
| Form | Sealed index entries, one per message | One sealed FTS5 segment, plus any entries that arrived after it was built |
| Written by | Server, at delivery | Client, by compaction |
| Mutability | Appended on each delivery | A new generation replaces the old one |
| Client caching | Entries fetched incrementally (the live tail) | Fetched once per generation, cached indefinitely |

**Weeks are ISO weeks in UTC**, keyed on the server's receipt time, never the message's `Date:` header — that header is sender-controlled and would let a sender place mail into an already-compacted week. Backfilled and imported mail is keyed on its original receipt or sort date and can therefore arrive in a closed week.

A closed week becomes eligible for compaction a configurable grace period (default 24 hours) after it ends, to absorb delayed delivery. Entries that arrive in a week after it has been compacted wait for the next compaction, which produces a new **generation** of that week's segment. Compaction is a compare-and-swap on the generation, and the upload names the entries it folded in. Two devices racing to compact the same week therefore cannot lose entries: the loser re-reads the manifest, and an entry that arrived while a compaction was being built is not in its list, so it stays pending for the next generation. After a successful upload the server deletes exactly the folded entries and the previous generation. The server refuses a segment that is not CMS `EnvelopedData` addressed to one of the mailbox's zero-access certificates, so it never stores what could be a readable index.

A week that no client has compacted yet is still fully searchable from its entries; compaction is an optimisation and MUST NOT be required for correctness.

**Who compacts.** Compaction downloads a week's entries and its current segment, builds the new segment and uploads it — exactly the cost this design keeps off phones. Clients therefore take a week in a preference order, staggered from the week's `compactableAt`, and the generation compare-and-swap settles any overlap:

| Platform | Takes a week | Declines |
|---|---|---|
| Desktop (the native app on a computer) | At once | Never |
| Web (a browser on a computer) | 6 hours after `compactableAt` | Never |
| Mobile (the native app on a phone or tablet, or a phone browser) | 24 hours after `compactableAt` | A week whose `pendingBytes` plus its current segment's `bytes` exceed 5 MB, and any week while on a cellular or data-saver connection |

A user who has a desktop or web client signed in therefore never has a phone compact. Someone who uses only a phone still gets small weeks compacted, a day later. A large week stays as entries, which costs nothing but a longer live-tail read.

### The Live Tail

Recent mail is the mail users search for most, and it must be searchable immediately. Because the current week is a list of entries rather than a segment, there is nothing to republish: a client fetches the entries newer than the last one it has seen and inserts them into its local index. A client that has been offline fetches the entries it missed on reconnect.

### Mutations

A message's content never changes, but its **state** does — it is moved, flagged, read, deleted. Segments and entries are immutable and MUST NOT be rewritten for state changes.

Instead: **the segment answers "which messages contain these terms"; Source A answers "which messages currently exist, where, and in what state."** The client intersects the two at query time.

A deleted message's pending entry is deleted with it. A deleted message already compacted into a segment is not removed from that segment; it is absent from Source A, so it never appears in results. Later generations of a week MAY omit messages no longer present.

### Segment Keys

Entries and segments are encrypted to the mailbox's **zero-access public key**, using the same CMS construction as the messages themselves. A symmetric index key is not used: the server writes entries at delivery and cannot hold a key that decrypts.

On zero-access key rotation the old private key is retained, exactly as old E2E encryption keys are, so existing entries and segments stay readable without re-encryption. Escrow covers the index with no extension, because the zero-access private key is wrapped under MK.

## 8. Segment Synchronisation

**Manifest.** The server exposes a per-mailbox manifest listing every segment (week, generation, byte size, ETag, schema version, origin) and the number of pending entries per week. The manifest is small and MUST be cheap to poll.

**Fetch policy.** The client fetches eagerly backwards from the present until its byte budget is reached, and fetches older segments **on demand** when a query's date range or an explicit "search all mail" reaches past what is cached.

On-demand fetch is what makes the local budget a caching decision rather than a coverage limit. Any segment is reachable; only latency differs.

**Caching.** A segment generation is immutable and MUST be cached indefinitely, validated by ETag. Only pending entries are fetched routinely, incrementally after the last entry seen.

**Eviction.** Oldest-first against the byte budget, excluding the current week. An evicted segment is re-fetchable, so eviction is never destructive.

**Cold start.** A newly unlocked device downloads the manifest, the current week's entries and the most recent segments. It is searchable over recent mail within seconds and over the full mailbox as fast as it can fetch. No reindexing occurs.

This is the principal gain over a client-built index: the first-run experience is a download, not a decrypt-and-index pass over the entire mailbox.

## 9. Attachment Extraction

This is the one genuine tension that zero-access introduces, and it must be resolved deliberately.

`AttachmentExtractionJob` is **asynchronous by design** — the existing code comments state that extraction can be slow and must not block SMTP-ACK. But indexing must happen inside the delivery transaction, because that is the only moment plaintext exists. An asynchronous job would require a plaintext spool, and **a plaintext spool outside the delivery transaction defeats zero-access entirely.**

### Resolution

Extraction moves **into** the delivery path under a tight time budget:

- A short budget — default 5 s, against the current asynchronous 30 s — and a reduced size cap.
- Extraction that completes within budget is indexed server-side with the message.
- Extraction that exceeds budget, exceeds the cap, or has no registered extractor is **deferred to the client**, which extracts from the decrypted attachment and writes the terms into a client-built segment (Source C).
- A deferred attachment is not an error. It is simply not content-searchable until a client processes it, matching the existing semantics where an unsupported or oversized attachment is skipped silently and remains findable by filename.

SMTP tolerates multi-second delivery latency, and the budget applies only to messages carrying extractable attachments. The common case is unaffected.

### Rejected Alternatives

- **Encrypted service-key spool.** Keeping the plaintext briefly under a key the extraction worker can read. Simpler to build, but it recreates a window in which the service can read mail at rest, which is the property being bought. If a deployment chooses it anyway, the documentation MUST say so.
- **Fully client-side extraction.** Correct but wasteful: every device repeats the same PDF parse, and it reintroduces the mobile cost the prebuilt index exists to remove.

Filenames, extensions and MIME types are envelope-level and remain in Source A regardless of extraction outcome.

## 10. Ranking and Merge

Scores from the three sources are not comparable. `ts_rank` and OpenSearch `_score` occupy different ranges from FTS5 `bm25()`, and Source A over encrypted mail ranks on `participants` alone.

**The client MUST compute final relevance**, using one scoring function over the segment matches, applying the existing field weights so ordering matches today's behaviour:

| Field | Weight |
| --- | --- |
| `subject` | 3 |
| `participants` | 2 |
| `body` | 1 |
| `attachmentText` | 1 |

FTS5's `bm25()` accepts per-column weights directly, so this maps onto the segment schema without a custom scorer.

Source A results for unencrypted entities arrive with a server score and MUST be normalised into the same space, by a normalisation function defined once and shared rather than implemented per provider.

**A result matched only in Source A** — an encrypted message whose segment is not yet cached — carries no content relevance. It MUST be rendered as a skeleton in place, positioned by its metadata score, never at a fabricated content score and never deferred to the end of the list. On segment arrival it takes its true position or is pruned.

### Snippets

Snippets are generated client-side from segment data using FTS5 `snippet()` and `highlight()`. Source A results for unencrypted entities may carry a provider snippet; these MUST be visually indistinguishable from client-generated ones.

This remains an opportunity to populate `snippet` in `OpenSearchProvider`, which leaves it undefined despite the interface declaring it.

## 11. Progressive Results

Sources report at very different speeds: Source A in tens of milliseconds, cached segments nearly as fast, an on-demand segment fetch in seconds. The UI MUST reflect an in-progress search rather than presenting partial results as complete.

**Never show a hard count until every source has reported.** Display `n of ??`, or omit the count. A settled count is the signal that ordering is final.

**Unresolved results MUST be rendered as skeleton entries in place**, not appended on arrival. A skeleton claims its slot, so resolution is a fill rather than an insertion, and the list does not grow under the reader.

**Reordering is permitted and preferred over appending.** A highly relevant result that resolves late must take its correct position; burying it at the end makes search useless precisely when it matters. Movement MUST be animated rather than instantaneous.

**Skeletons resolve or are pruned**, and MUST be capped at approximately one and a half pages. Resolve the visible set, then extend.

**Calendar grid views** are the easy case: position is temporal and temporal fields are plaintext (§4), so an encrypted event renders in its correct cell from the first frame with a skeleton title, and never moves.

## 12. Pagination

The offset cursor does not survive a merge across sources. The merged cursor MUST be a composite, opaque at the API boundary, carrying at minimum:

- the Source A offset consumed so far,
- the per-segment positions consumed so far,
- the set of segments still outstanding,
- a query fingerprint, so a cursor cannot be replayed against a different query.

The client MUST over-fetch from each source relative to the requested page size, because final scoring reorders results.

## 13. Client Capability Matrix

Search fidelity remains a property of the client, but the gap narrows substantially: clients consume a prebuilt index rather than building one, so the differences are storage and bandwidth rather than CPU.

| Client | Segment cache | Attachment deferral | Fidelity |
| --- | --- | --- | --- |
| Native desktop | Full mailbox, disk-limited | Handles deferred extraction | Full |
| Native mobile | Recent segments; older on demand | Handles deferred extraction, reduced caps | Full, with fetch latency on old mail |
| Web | Recent segments, quota-limited; older on demand | Best-effort | Full, with fetch latency on old mail |
| **Outlook (MAPI/EAS)** | **None** | **None** | **Encrypted mail is not content-searchable** |

The Outlook row is unchanged and unavoidable: a client that cannot hold a RapidMX segment cache or decrypt on RapidMX's behalf cannot search encrypted content. Envelope search via Source A still works. This is a documented limitation and MUST appear in user-facing documentation.

## 14. Index Lifecycle and Sizing

**Protection at rest.** The decrypted segment cache and the client-built live index are plaintext-derived and MUST be encrypted at rest under a local cache key derived from MK, never persisted in plaintext. They MUST be destroyed on the events that destroy private keys: explicit logout, session revocation, and the configurable idle timeout.

**Invalidation.** The cache MUST be discarded on index-key rotation, on segment schema version change, and on detection of corruption. Discarding is cheap — segments are re-fetchable.

**Storage budget.** The client MUST track cache size against its budget and evict rather than fail writes. On web, quota-exceeded MUST be handled as a normal operating state.

### Sizing

Segment size is approximately `extractable_text_bytes × ratio`. The ratio depends on whether term positions are stored — required for phrase search — and whether snippets are cached. A term-only index lands well under half the source text; a positional index with a snippet cache can approach it. Email averages a few KB of extractable text after HTML stripping, putting the expected cost in the low single-digit KB per message.

| Platform | Eager cache budget | Beyond the cache |
| --- | --- | --- |
| Native desktop | Disk-limited; typically the whole mailbox | — |
| Web | ~500 MB | On-demand segment fetch |
| Native mobile | ~250 MB | On-demand segment fetch |

**The rationale for these numbers has changed.** In the previous design the limit was *build cost* — decrypting and indexing tens of thousands of messages on a phone is a battery and thermal event. With a prebuilt index there is no build, so the limit is now storage and bandwidth alone. Mobile may be able to cache considerably more than the earlier design allowed; this is an input to §19.3.

### Platform Hazards

**Browser storage is evictable.** Safari's policy is materially stricter than Chrome's and has historically evicted origin data after a period without interaction. A web cache can disappear with no user action. The client MUST treat a missing cache as normal and re-fetch, never as an error — which is now a download rather than a rebuild, making the hazard far less costly than it was.

**Quota is shared across the origin.** The budget MUST be a fraction of available quota, re-evaluated rather than assumed fixed.

**Persistent storage SHOULD be requested** where offered, but MUST NOT be assumed granted.

## 15. Interface Changes

Additive to the existing contracts.

```ts
/** Which source produced a result. */
export type SearchResultSource = "metadata" | "segment-server" | "segment-client";

export interface SearchResult {
    entityType: SearchEntityType;
    entityUid: string;
    score: number;
    snippet?: string;
    source?: SearchResultSource;
    /** True when `score` derives from envelope metadata only and is not comparable to content-scored results. */
    metadataOnly?: boolean;
}

export interface SearchResultPage {
    results: SearchResult[];
    nextCursor?: string;
    /** Present while segment coverage is incomplete. */
    coverage?: {
        /** Oldest period covered by a locally cached segment. */
        cachedFrom?: Date;
        /** Segments matching the query that are not yet cached. */
        pendingSegments: number;
        /** True while any segment fetch is in flight. */
        fetching: boolean;
    };
}

/** One compacted segment in the per-mailbox manifest. */
export interface IndexSegment {
    /** ISO week in UTC, e.g. `2026-W43`. */
    weekId: string;
    /** Increments each time the week is re-compacted with later entries. */
    generation: number;
    /** How many entries this generation and the ones before it folded in. */
    entryCount: number;
    /** Fingerprint of the zero-access key the segment is encrypted to. */
    keyFingerprint: string;
    /** Who built it. Zero-access segments are compacted from server entries; client segments cover E2EE content. */
    origin: "zero-access" | "client";
    bytes: number;
    etag: string;
    /** Segment format version, so a client can decline a segment it cannot open. */
    schemaVersion: number;
}

/** Pending (not yet compacted) entries for one week. */
export interface IndexWeekEntries {
    weekId: string;
    pendingEntries: number;
    /** When the newest pending entry was written (ISO 8601). */
    latestEntryAt: string;
    /** True once the week has closed and its grace period has elapsed, so a client may compact it. */
    compactable: boolean;
    /** When it becomes (or became) compactable (ISO 8601) - the start of the platform stagger under *Who compacts*. */
    compactableAt: string;
    /** Size of the week's pending sealed entries (bytes of base64). */
    pendingBytes: number;
}

export interface SegmentManifest {
    mailboxUid: string;
    segments: IndexSegment[];
    weeks: IndexWeekEntries[];
}

/** One sealed index entry, as served to the client. `sealed` is CMS EnvelopedData to the zero-access key. */
export interface SealedIndexEntry {
    uid: string;
    weekId: string;
    messageUid: string;
    /** When the entry was written (ISO 8601). The live tail asks for entries written since shortly before its last poll and drops the
     * ones it already has, so an entry committed late is never skipped; pages within that set are ordered by `uid`. */
    createdAt: string;
    keyFingerprint: string;
    sealed: string;
}

/**
 * Extends the existing SearchQuery. `text` is retained for simple callers;
 * `query` carries the parsed AST (§17) when structured predicates are used.
 * Exactly one of the two MUST be supplied.
 */
export interface SearchQuery {
    mailboxUid: string;
    text?: string;
    query?: QueryNode;
    entityTypes?: SearchEntityType[];
    limit?: number;
    cursor?: string;
}
```

`SearchProvider` is unchanged in shape; providers gain the ability to translate `SearchQuery.query` and index the additional envelope fields. Segment storage and the manifest are a separate route — they serve opaque blobs and are not a search provider concern.

**`CandidateQuery` is removed.** The server-assisted candidate narrowing it supported no longer exists; on-demand segment fetch replaces it.

## 16. Segment Implementation

**SQLite with FTS5**, compacted on a client from server-extracted entries and consumed on every client platform. Native SQLite on desktop and mobile; SQLite compiled to WebAssembly over OPFS on web.

### Segment format versions

- **Version 1 (current): an entries bundle.** The sealed file is gzipped JSON, `{ "v": 1, "documents": ZeroAccessIndexDocument[] }`: the same documents the week's entries carry, merged, one per message. A client imports it through the same insert path as individual entries, so every backend (web wa-sqlite over the page-encrypting VFS, tauri's native SQLCipher) can import it with no new storage primitive.
  - Why not a SQLite file yet: web's local index encrypts every page under its own key (`localIndexVFS.ts`), so a downloaded SQLite file can't be `ATTACH`ed without a second, plain VFS, and wa-sqlite exposes no `sqlite3_deserialize` wrapper.
  - The cost is FTS tokenisation on import instead of a page copy. That is acceptable at a week's volume.
- **Version 2 (unscheduled): a SQLite FTS5 database file** as the rest of this section describes, once clients can open one directly. The server stores segments as opaque bytes with their `schemaVersion`, so the change needs no server work, and a client declines a version it can't open.
  - It is deliberately left unscheduled until §19.5 measures whether version 1's import cost matters in practice.
  - Its gain is replacing re-tokenisation on import with a page copy. That only matters for a cold start over many weeks of segments, or on low-end devices.

### Rationale

The decisive property is that **a segment built on the server opens directly on the client**. The SQLite file format is stable and endian-independent, so one builder produces artifacts every platform can read with no import or transcode step. No JavaScript index library offers a portable on-disk format with this guarantee.

Beyond portability:

| Requirement | SQLite FTS5 | JS libraries (Lunr, FlexSearch, MiniSearch, Orama) |
| --- | --- | --- |
| Portable prebuilt artifact | Yes — the point of the design | No; serialise/deserialise per library |
| Per-field ranking weights | `bm25()` accepts per-column weights | Varies; approximation at best |
| Snippet generation | `snippet()` and `highlight()` built in | Mostly absent |
| Phrase and prefix queries | Native | Partial |
| Incremental append (live tail, compaction) | Native | Whole index must be re-serialised |

The server needs no SQLite at all: it produces sealed entries, and clients compact them.

### Web Platform Constraints

- **OPFS sync access handles are Worker-only**, which aligns with keeping segment work off the UI thread.
- **Choose the SAH Pool VFS.** The plain `opfs` VFS requires cross-origin isolation via COOP and COEP headers; the SAH Pool VFS does not, at the cost of being single-connection.

### Encryption at Rest

Two distinct problems, and the prebuilt design simplifies one of them.

**Segments in transit and in the segment store** are encrypted as whole files to the zero-access public key, using the same CMS construction as zero-access messages. This is straightforward: a segment is an opaque blob to everything except the client that decrypts it. **No custom VFS is required for this.**

**The decrypted local cache** is the harder case, unchanged from the earlier design:

- **Native:** the decrypted cache is encrypted at rest with a key derived from MK (the Tauri client persists it as one libsodium-sealed blob; SQLCipher is not used).
- **Web:** no official SQLCipher WASM build exists; page-level encryption requires a custom VFS over OPFS.

Content MUST NOT be encrypted before insertion into FTS5 — the index requires plaintext tokens, and encrypting them reduces the design to the keyword index rejected in §6. Protection is at the storage layer, not the record layer.

**The web risk is now materially lower.** If an encrypting VFS proves unworkable, the fallback is to decrypt segments into memory per session rather than persisting a decrypted cache — slower on each unlock, but viable, because re-obtaining a segment is a fetch rather than a rebuild. The earlier design had no such fallback.

## 17. Query Grammar

Search gains structured predicates alongside free-text relevance matching. The grammar applies to **all sources** — encrypted and unencrypted results must respond to one query language, or the source boundaries become visible to the user.

### Reuse the RapidREST Operator Vocabulary

RapidREST's `ModelUtils` already defines an `op(value)` operator grammar for URL query parameters, with type coercion that attempts JSON, then `Date`, then string. Search MUST reuse this vocabulary rather than introduce a parallel `from:` / `before:` syntax. One language, learned once.

| Operator | Meaning | Already implemented |
| --- | --- | --- |
| `eq` | Exact match | Yes |
| `ne` | Not equal | Yes |
| `gt`, `gte`, `lt`, `lte` | Ordered comparison | Yes |
| `in`, `nin` | Set membership | Yes |
| `range(a,b)` | Inclusive bounds | Yes |
| `like` | Pattern match | Yes — **but see divergence below** |
| `not` | Negation | Yes — **but see divergence below** |

Two of the requested capabilities need no new operators at all:

- **Date ranges** are `date=range(2026-01-01,2026-07-01)`. `getQueryParamValue` already coerces both operands to `Date`, producing TypeORM `Between` or Mongo `$gte`/`$lte`.
- **Multi-value matching** is `in()` / `nin()`.

### The Boolean Gap

`buildSearchQuerySQL` constructs `where` as an array, which TypeORM treats as a disjunction, and pads every branch with every key — repeating a key's last value rather than leaving it unset, because an unset key would match anything.

The expressible form is therefore **a disjunction of full conjunctions — DNF, with no nesting, and no key absent from any branch.**

This cannot express what search requires:

```
(from = bob AND hasAttachments = true) OR (subject ~ budget AND date > march)
```

The search endpoint MUST therefore accept a **parsed abstract syntax tree** rather than flat query parameters, while reusing the operator semantics above at the leaves. Transport is the existing base64-encoded `q` parameter path, which already bypasses the flat-parameter parser and is validated by `assertNoOperatorInjection`.

```ts
export type QueryNode = GroupNode | PredicateNode | TextNode;

/** Boolean grouping. Arbitrarily nestable. */
export interface GroupNode {
    kind: "group";
    op: "and" | "or";
    negated?: boolean;
    children: QueryNode[];
}

/** A structured field predicate, using the RapidREST operator vocabulary. */
export interface PredicateNode {
    kind: "predicate";
    field: string;
    op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "nin" | "range" | "like";
    value: unknown;
}

/** Free text, which drives relevance ranking rather than filtering. */
export interface TextNode {
    kind: "text";
    /** Terms as entered. */
    terms: string;
    /** True when the input was quoted and must match as a phrase. */
    phrase?: boolean;
    negated?: boolean;
}
```

Parsing MUST happen once, client-side, producing this tree. Every tier translates the same tree, so tiers cannot diverge in interpretation.

Depth and node count MUST be bounded. An unbounded tree is a denial-of-service vector against every provider.

### Known Divergences to Resolve First

Two operators behave differently by backend today. Both MUST be resolved before the grammar is exposed through search, because a query returning different results per provider defeats the purpose of a shared tree.

**`like` is not portable.** The SQL path maps to TypeORM `ILike(value)` — SQL `LIKE` semantics with `%` and `_` wildcards. The Mongo path maps to `{ $regex: pattern, $options: "i" }` — a JavaScript regular expression. These are different pattern languages: `like(%.xls)` works only on SQL, `like(.*\.xls)` only on Mongo. The ReDoS guard `isUnsafeRegexPattern` is applied only on the Mongo path, consistent with that asymmetry.

Recommended resolution: define `like` as glob semantics (`*`, `?`) at the AST level and have each provider translate — to `LIKE` patterns on SQL, to an anchored escaped regex on Mongo, to `GLOB` on SQLite. Raw regex is then never accepted from the client.

**`not` is likely broken on Mongo for scalars.** `getQueryParamValueMongo` returns `{ $not: value }`. MongoDB's `$not` accepts an operator expression or a regex, not a scalar, so `{ field: { $not: "x" } }` errors. The SQL path maps `ne` and `not` identically to `Not(value)`. This should be verified against a real MongoDB instance and, if confirmed, `not` on a scalar should compile to `$ne`.

### Attachment Matching Without Regex

Matching `*.xls` MUST NOT be implemented as a regex predicate. Unanchored regex cannot use the index on any of the three providers: Postgres `~` falls back to a sequential scan, Lucene `regexp` queries are expensive and support only a subset of the syntax, and unanchored Mongo `$regex` cannot use an index.

Index the components instead:

| Field | Purpose |
| --- | --- |
| `attachmentNames[]` | Filenames, for glob matching |
| `attachmentExt[]` | Lowercased extensions, as exact-match keywords |
| `attachmentTypes[]` | MIME types |
| `hasAttachments` | Presence, independent of whether text extraction succeeded |

`attachmentExt=eq(xls)` is then an exact keyword match, fast on every provider, and is what the user actually meant. Glob against `attachmentNames` covers the remainder.

**Client-side regex MAY be offered as a post-filter** over an already-narrowed result set, never as a primary predicate.

### Fuzzy Matching: Did-You-Mean, Not Inline

Fuzzy matching has no equivalent in `ModelUtils` and diverges sharply across providers: OpenSearch has native Levenshtein `fuzziness`, Postgres `tsvector` has none without a separate `pg_trgm` column, Mongo `$text` has none, and FTS5 has none.

RapidMX MUST therefore implement **correction, not inline expansion**:

1. Execute the query as entered.
2. If the result count falls below a threshold, run a correction pass against terms harvested from the user's own index.
3. Offer the correction — "Did you mean: *meeting notes*" — rather than silently substituting it.

This behaves identically on every provider, avoids distorting ranking with low-confidence expansions, and matches user expectation. Inline fuzziness MAY be enabled as an enhancement where the provider supports it natively, but MUST NOT be required for correctness.

Correction candidates MUST come from the user's own index, never a shared dictionary, so that suggestions do not leak terms across mailboxes.

### Required Schema Changes

`SearchDocument` cannot support these predicates as currently defined:

| Gap | Change |
| --- | --- |
| `participants[]` flattens sender and recipients, so sender and recipient cannot be distinguished | Split into `from`, `to[]`, `cc[]`; retain `participants[]` as the union for existing free-text ranking |
| Folder is absent | Add `folderUid` |
| Flags are absent | Add `flags[]` |
| Attachment metadata is absent — `attachmentText[]` holds extracted content only, and is empty when extraction was skipped | Add `attachmentNames[]`, `attachmentExt[]`, `attachmentTypes[]`, `hasAttachments` |

All additive. A full re-index is required on deployment, and SHOULD be sequenced separately from the E2E rollout — a large-mailbox re-index is disruptive on its own and should not be entangled with a crypto migration.

### Provider Translation

Predicates become filters; free text continues to drive relevance ranking.

- **Postgres:** free text compiles from `TextNode`s to a generated `tsquery`. Client input MUST NOT be passed to `to_tsquery`, which throws on malformed input; the tree is serialised into a known-valid expression. `websearch_to_tsquery` is unsuitable for nested boolean because it does not support grouping. Predicates become `WHERE` clauses alongside the existing `search_vector @@` match.
- **OpenSearch:** `GroupNode` maps to nested `bool` with `must` / `should` / `must_not`. Free text stays a `multi_match` in `must`; predicates become `term` and `range` clauses in `filter`, contributing no `_score`.
- **Mongo:** `$and` / `$or` / `$nor` for grouping, `$text` for free text. **Note the limitation:** `$text` supports only an OR of terms plus `-` negation — no grouping within the text portion itself. Mongo is therefore a reduced-capability provider for this grammar and MUST be documented as such, or reconsidered.
- **Local (FTS5):** FTS5 `MATCH` supports `AND`, `OR`, `NOT` and parentheses natively. Predicates become SQL `WHERE` clauses on the same table.

### Boolean Structure and Segment Selection

A rule that follows from boolean grouping and is not obvious:

**`AND` narrows which segments must be consulted; `OR` with an unbounded branch widens it to all of them.**

`from=eq(bob) AND date=range(2026-01-01,2026-03-31)` touches one or two segments. `from=eq(bob) OR subject~budget` cannot be bounded by date at all, so every segment matching the rest of the query must be consulted — and any not yet cached must be fetched.

This is far cheaper than the previous design's full-mailbox decrypt, but it is still the difference between a local query and a multi-segment download. The parser MUST detect a disjunction with no date bound and surface it as a progressive "searching older mail…" state rather than appearing to hang.

Fields evaluable in Source A without touching any segment: `from`, `to`, `cc`, `date`, `folderUid`, `flags`, `hasAttachments`, `attachmentExt`, `entityType`, and for encrypted calendar events all temporal fields (§4). Everything else requires a segment.

## 18. Non-Goals

- **Encrypted server-side ranking.** No construction computes relevance over ciphertext. The server builds the index in plaintext at delivery or not at all.
- **Verifiable server-built segments.** A client cannot prove a server indexed honestly (§5). Deployments that require this disable zero-access and use client-built segments throughout.
- **Query privacy against the client's own server for metadata.** The server already sees participants and dates.
- **Parity with plaintext search on Outlook.** Not achievable; documented instead.

## 19. Measurement and Verification Tasks

### 19.1 Verify `not` on MongoDB

`getQueryParamValueMongo` compiles `not(value)` to `{ $not: value }`. MongoDB's `$not` accepts an operator expression or a regex, not a scalar. Confirm against a real instance whether `not(somestring)` errors, and if so compile scalar negation to `$ne`. The SQL path maps `ne` and `not` identically, so the backends currently disagree.

Pre-existing in `ModelUtils` and independent of search, but user-visible once the operator vocabulary is exposed.

### 19.2 Unify `like` semantics

Implement the glob translation in §17. Until then `like()` means SQL `LIKE` on one backend and a JavaScript regex on the other.

### 19.3 Measure segment size and build cost

Two measurements, serving different decisions.

**Segment size**, which sets the cache budgets in §14:

1. Build an FTS5 segment over at least 10,000 real messages, post-HTML-stripping.
2. Measure term-only and positional-with-snippet-cache separately; the ratio differs substantially.
3. Measure the on-disk file including FTS5 auxiliary tables.
4. Derive how many months each platform budget holds, and revise the table — mobile in particular may now afford considerably more than the earlier build-cost-bound figure.

**Delivery-path build cost**, which is new and gates §3:

1. Measure added latency per message for indexing inside the delivery transaction.
2. Measure added latency for in-budget attachment extraction (§9), separately for PDF and DOCX at the proposed reduced cap.
3. Confirm the total stays within a safe margin of SMTP client timeouts under realistic concurrency.
4. If it does not, the 5 s extraction budget — not the zero-access property — is what gets reduced.

### 19.4 Validate the compaction grace period

Determine the grace period after a week closes before it is compacted (default 24 hours). Too short and delayed mail forces frequent re-compaction into new generations; too long and clients carry a closed week as individual entries for longer than necessary.

### 19.5 Measure segment import cost (gates segment format version 2)

Measure how long a device takes to import version 1 segments (§16) on a cold start - a newly unlocked device over a large, long-lived mailbox - on web (wa-sqlite over the encrypting VFS) and tauri, on a typical laptop and a low-end phone. Version 2 (SQLite files imported by page copy) is scheduled only if that time is unacceptable: searchable recent mail is the bar, since segments import newest first.

## Resolved

| Question | Decision |
| --- | --- |
| Zero-access encryption | Adopted. Mail encrypted at delivery to a dedicated per-mailbox zero-access public key; plaintext discarded. Server-wide "Allow" setting (administrator, default on) plus per-mailbox "Enable" setting (owner only, default on). |
| Zero-access key | Dedicated keypair, `useType: "zero-access"`, wrapped under MK, never published. Exportable with the E2E encryption keys as PKCS#12 for Outlook and phones. |
| Zero-access scope | Every write of message content: delivery, Sent copies, drafts, imports, quarantine, protocol and plugin submissions. Subject and preview included, as a sealed summary. |
| Existing mail on enablement | Backfilled: indexed, encrypted and discarded by a background job. Disabling never decrypts. |
| Shared mailboxes | The mailbox's zero-access private key is wrapped to each member's own zero-access certificate. Removing a member rotates the key. |
| Zero-access vs. E2EE naming | Distinct properties, distinct indicator states. Zero-access MUST NOT be described as end-to-end. |
| How content stays searchable | Server extracts and indexes content during delivery into a sealed per-message entry. Clients compact closed weeks into sealed FTS5 segments. Search happens on the client after decryption. |
| Segment granularity | ISO weeks in UTC, keyed on server receipt time. The current week is a list of sealed entries; closed weeks are compacted into one segment per generation. |
| Why the server cannot keep a hot segment | Appending requires reading it, and a segment the server can read is a plaintext index at rest. |
| Recent mail | Searchable immediately: clients fetch new entries incrementally. Nothing is republished. |
| E2EE content the server cannot see | Client builds segments in the same format and uploads them encrypted, so other devices inherit them. |
| State changes (move, flag, delete) | Never rewrite a segment. Source A is the authority on current state; the client intersects at query time. |
| Segment encryption key | The zero-access public key, not a symmetric index key (the server cannot use one). Old private keys are retained on rotation, so nothing is re-encrypted. |
| Attachment extraction | Moves into the delivery path under a tight budget; overruns defer to the client. A plaintext spool is rejected — it defeats zero-access. |
| Server-assisted candidate narrowing | Removed. On-demand segment fetch replaces it; `CandidateQuery` is deleted. |
| Cache budget rationale | Storage and bandwidth, not build cost. Clients no longer build an index for zero-access mail. |
| Honest trust statement | A server-built index entry is trusted to be honest. Different from, not larger than, the delivery-time trust already required. |
| Which entity types are encrypted | End-to-end: scoped by provenance, not type. Messages per policy; calendar events when derived from an encrypted **external** message or originated as an encrypted invitation; contacts never. At rest (zero-access): per data type, chosen by the owner — mail, calendar, contacts (all but email addresses), tasks. |
| Which zero-access types are on by default | All, unless the owner syncs with ActiveSync or Outlook: then the types those clients use default to off (mail stays on once the keys are exported). Any type can be switched on, with what it breaks stated plainly. |
| Why contact email addresses stay readable | Mail routing, end-to-end key lookup and pinning, known-sender detection and contact suggestions all match on them, and the server already sees them in mail headers. |
| Can a user originate an encrypted invitation | Yes, at any tier. The organiser's own copy is encrypted, per encrypt-to-self. |
| Explicit user choice vs. tier scoping | Explicit choice wins. Automatic protection is external-only; a deliberate decision to encrypt applies everywhere. |
| Free/busy for encrypted events | Preserved. Temporal fields stay server-visible; content fields are encrypted. |
| Encrypted calendar fields | Title, notes, location, attachments only. Attendees, RSVP status, organiser and all temporal fields stay plaintext. |
| Why attendees stay plaintext | Already server-visible via `To`/`Cc` headers, which RFC 9788 retains by default. Encrypting them would protect nothing while breaking RSVP and delegation. |
| Does a correspondent's `prefer-encrypt` change contact storage | No. It is a statement about messages in transit, not about the recipient's address book. |
| Contact enrichment from encrypted content | Prohibited, eliminating mixed-provenance records entirely. |
| Same-organisation derived entities | Not *automatically* protected, but inheritance follows the message's actual encryption state. |
| Provenance storage | Denormalised `EncryptionOrigin` enum on the entity, not a reference to the source message. |
| Provenance on edit vs. copy | Edits, updates and series exceptions inherit. Duplicates and templates do not, but the compose toggle defaults to on when copying from an encrypted source. |
| Administrator recovery | Via the existing escrow wrap on the mailbox master key, which unwraps the zero-access private key and therefore covers messages, entries and segments. |
| Late-arriving results | Skeletons rendered in place, reordering permitted, pruning on non-match. Appending is prohibited. |
| Result counts during search | No hard count until all sources report. `n of ??` until settled. |
| Calendar grid views | No restriction. Position is temporal and therefore plaintext. |
| Segment engine | SQLite FTS5, compacted on a client from server-extracted entries, opened directly on every client. Portable file format is the deciding property. |
| Query operator grammar | Introduced, applies to all sources, so source boundaries stay invisible to the user. |
| `SearchDocument` schema | Additive: split `from`/`to`/`cc`, add `folderUid`, `flags[]`, `hasAttachments`, `attachmentNames[]`, `attachmentExt[]`, `attachmentTypes[]`. Full re-index, sequenced separately from the E2E rollout. |
| Query transport | Parsed AST via the existing base64 `q` path. Flat URL params cannot express nested boolean. |
| Operator vocabulary | Reuse RapidREST's `op(value)` set. `range()` already covers date ranges. |
| Attachment matching | Indexed `attachmentExt[]` keyword, not regex. |
| Fuzzy matching | Did-you-mean correction, not inline expansion. Candidates from the user's own index only. |
| Mongo capability | Reduced. `$text` cannot group, so nested boolean over free text is unsupported. |

## Status

The architecture is settled. Five tasks in §19 remain: two pre-existing `ModelUtils` operator divergences that must be resolved before the query grammar is exposed, two measurements — segment size and delivery-path build cost — that gate configuration values rather than the design, and the segment import measurement (§19.5) that decides whether segment format version 2 is built.

**The delivery-path build cost measurement (§19.3) is the one that could force a change.** If indexing plus in-budget attachment extraction cannot fit inside the delivery transaction at realistic concurrency, the extraction budget shrinks and more work defers to clients. The zero-access property itself is not negotiable against that measurement.
