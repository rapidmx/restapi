///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ModelUtils, RecoverableBaseEntity } from "@rapidrest/service-core";
import { findPagesByUid, MailboxContentRepos } from "../util/MailboxContentUtils.js";

/**
 * Yields one JSON line, tagged `deleted: true`, for every soft-deleted row of the recoverable entity types
 * (`Message`, `Contact`, `CalendarEvent`, `Task`, ...) a mailbox owns. A plain `find()` on a recoverable entity leaves
 * soft-deleted rows out (a user's ordinary `DELETE` only flags them), yet they are still stored, restorable and still
 * the mailbox's data - `collectMailboxContentLines()` therefore misses them, and an export that relies on it alone
 * omits exactly the mail a custodian deleted. `messageDateRange` narrows the messages by `sentDate`, as there.
 *
 * `rowsHeld` is how many rows the caller already has; going past `maxRows` in total throws, as `collectMailboxContentLines()`
 * does, rather than yielding a bundle that is silently cut short.
 *
 * `repos` holds one repository per entity type; a repository is skipped unless its model class is a `RecoverableBaseEntity` (read off
 * the repository itself, as `RepoUtils` does for its own soft-delete handling).
 */
export async function* softDeletedContentLines(
    repos: MailboxContentRepos,
    mailboxUid: string,
    messageDateRange: { start: Date; end: Date } | undefined,
    rowsHeld: number,
    maxRows: number,
): AsyncGenerator<string> {
    let rows = rowsHeld;
    for (const [entityType, repo] of Object.entries(repos)) {
        if (!((repo as any).modelClass?.prototype instanceof RecoverableBaseEntity)) {
            continue;
        }
        const criteria: Record<string, any> = { mailboxUid: ModelUtils.literal(mailboxUid), deleted: true };
        if (entityType === "message" && messageDateRange) {
            criteria.sentDate = `range(${new Date(messageDateRange.start).toISOString()},${new Date(messageDateRange.end).toISOString()})`;
        }
        for await (const batch of findPagesByUid(repo, criteria)) {
            rows += batch.length;
            if (rows > maxRows) {
                throw new Error(`Mailbox ${mailboxUid}'s content exceeds the maximum of ${maxRows} exportable rows.`);
            }
            for (const row of batch) {
                yield JSON.stringify({ entityType, ...row, deleted: true });
            }
        }
    }
}
