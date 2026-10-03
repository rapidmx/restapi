///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators, type JWTUser } from "@rapidrest/core";
import { HttpRequest, RepoFindOptions, RouteDecorators } from "@rapidrest/service-core";
import { asEntity } from "../util/EntityUtils.js";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
import { Label, Message } from "../models/types.js";
import { BaseScopedChildRoute } from "./BaseScopedChildRoute.js";
const { Init } = ObjectDecorators;
const { Delete, Param, Query, Request, User: AuthUser } = RouteDecorators;

/** How many `Message`s `cleanUpDeletedLabel()` fetches per page while scanning a mailbox for messages that
 * still reference a just-deleted label - same pattern/size as `MailboxQuotaRecalcJob.findAllPages()`. */
const MESSAGE_PAGE_SIZE = 500;

/** The most pages of labelled messages one label delete cleans up - a bound, not a limit anyone reaches (500 messages a page). */
const MAX_CLEANUP_ROUNDS = 10000;

/**
 * Base CRUD route for the Gmail-style `Label` entity. `Label` has no `AccessControlList` of its own -
 * scoped/permission-checked by `mailboxUid`, same as `ContactList` - so this is otherwise a thin
 * `BaseScopedChildRoute` subclass. The one addition is `delete()`: since a `Label` is referenced by uid from
 * any number of `Message.labelUids` (never embedded by name/colour), deleting a label must also strip its
 * uid from every message that still carries it, or those messages would be left pointing at a label that no
 * longer exists.
 *
 * `Message.labelUids` is a `simple-json` column on the SQL backend (opaque JSON text, not a native queryable
 * array type - see the comment on `MessageSQL.labelUids`), so there's no efficient "find messages containing
 * label X" query available through the shared query DSL. Rather than building new SQL array-column machinery
 * for the real `Message` table, this reuses the codebase's established "paginated full scan + client-side
 * filter" pattern (`MailboxQuotaRecalcJob.findAllPages()`), scoped to the label's own `mailboxUid` and run
 * synchronously as part of the delete request. This trades away efficiency for a very large mailbox in
 * exchange for zero new schema/DSL work.
 *
 * The scan is narrowed to the messages that carry the label (`buildLabelUidsFilter()`, the same predicate the message list's label filter
 * uses), so a large mailbox costs one query per page of labelled messages rather than one per page of every message.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseLabelRoute<T extends Label, M extends Message> extends BaseScopedChildRoute<T> {
    protected readonly scopeProperty: string = "mailboxUid";

    /** Supplied by the Mongo/SQL concrete subclasses so `delete()` can clean up references to a deleted
     * label without depending on either backend directly. */
    protected abstract messageClass: any;

    /** The query that matches the messages carrying any of `labelUids` (`buildMessageLabelFilterMongo()`/`buildMessageLabelFilterSQL()`), supplied by
     * the Mongo/SQL concrete subclass - `Message.labelUids` is a native array on Mongo and JSON text on SQL. */
    protected abstract buildLabelUidsFilter(labelUids: string[]): Record<string, any>;

    protected messageRepo?: RecoverableRepoUtils<M>;

    @Init
    protected async initLabelRepos(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        if (!this.messageRepo && this.messageClass) {
            this.messageRepo = await this._objectFactory.newInstance(RecoverableRepoUtils, { name: this.messageClass.name, args: [this.messageClass] });
        }
    }

    /**
     * Strips `labelUid` from `labelUids` on every message in `mailboxUid` that still carries it. Runs after
     * the `Label` itself is already gone, so this operates with `ignoreACL: true` throughout (the caller's
     * permission to delete the label was already established by `super.delete()`) and reads/writes every
     * page of the mailbox's messages rather than just the first (see class doc comment).
     */
    private async cleanUpDeletedLabel(mailboxUid: string, labelUid: string): Promise<void> {
        const repo: RecoverableRepoUtils<M> = this.messageRepo!;
        // Only the messages that carry the label (`buildLabelUidsFilter()`), never the whole mailbox. Each one stripped drops out of that
        // filter, so every round reads the first page again; a round that stripped nothing ends it. A message the user deleted is still
        // there to be restored, so a second pass covers those (`find()` only returns them for an explicit `deleted: true`).
        for (const pass of [{}, { deleted: true }]) {
            for (let round = 0; round < MAX_CLEANUP_ROUNDS; round++) {
                const options: RepoFindOptions = { limit: MESSAGE_PAGE_SIZE, page: 0, ignoreACL: true };
                const batch: M[] = await repo.find({ mailboxUid, ...pass, ...this.buildLabelUidsFilter([labelUid]), limit: MESSAGE_PAGE_SIZE, page: 0 } as any, options);
                let stripped: number = 0;
                for (const message of batch) {
                    if ((message.labelUids ?? []).includes(labelUid)) {
                        await this.removeLabelFrom(repo, message, labelUid);
                        stripped++;
                    }
                }
                if (batch.length < MESSAGE_PAGE_SIZE || stripped === 0) {
                    break;
                }
            }
        }
    }

    /**
     * Removes `labelUid` from one message's `labelUids` under the optimistic lock - `find()` rows are plain documents on
     * Mongo, which `update()` would otherwise write back unversioned, silently undoing a concurrent edit. On a conflict
     * the message is re-read and retried.
     */
    private async removeLabelFrom(repo: RecoverableRepoUtils<M>, message: M, labelUid: string): Promise<void> {
        // The caller only passes a message whose `labelUids` includes `labelUid`.
        let current: M = message;
        for (let attempt = 1; ; attempt++) {
            try {
                await repo.update(
                    {
                        uid: current.uid,
                        version: current.version,
                        labelUids: current.labelUids!.filter((uid) => uid !== labelUid),
                    } as Partial<M>,
                    asEntity(repo, current),
                    { ignoreACL: true },
                );
                return;
                /* v8 ignore start -- only a concurrent write to the same message reaches here */
            } catch (err: any) {
                if (attempt >= 3 || err?.status !== 409) {
                    throw err;
                }
                const reread: M | undefined = await repo.findOne(message.uid, { ignoreACL: true, skipCache: true });
                if (!reread?.labelUids?.includes(labelUid)) {
                    return;
                }
                current = reread;
            }
            /* v8 ignore stop */
        }
    }

    @Delete("/:id")
    public async delete(
        @Param("id") id: string,
        @Query("version") version: string | undefined,
        @Query("purge") purge: string | undefined,
        @Request req: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<void> {
        const existing: T | undefined = this.repoUtils ? await this.repoUtils.findOne(id, { version, ignoreACL: true }) : undefined;

        await super.delete(id, version, purge, req, user);

        if (existing) {
            // The label is gone whatever happens here: a message this could not clean up keeps an id that names no label (shown as nothing),
            // which is no reason to answer a delete that happened with an error.
            try {
                await this.cleanUpDeletedLabel(existing.mailboxUid, existing.uid);
            } catch (err: any) {
                this.logger?.warn(`BaseLabelRoute: could not remove deleted label ${existing.uid} from every message of mailbox ${existing.mailboxUid}: ${err?.message}`);
            }
        }
    }
}
