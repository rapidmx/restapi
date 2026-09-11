///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { type JWTUser } from "@rapidrest/core";
import { HttpRequest, RepoFindOptions, RouteDecorators } from "@rapidrest/service-core";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
import { Label, Message } from "../models/types.js";
import { BaseScopedChildRoute } from "./BaseScopedChildRoute.js";
const { Delete, Param, Query, Request, User: AuthUser } = RouteDecorators;

/** How many `Message`s `cleanUpDeletedLabel()` fetches per page while scanning a mailbox for messages that
 * still reference a just-deleted label - same pattern/size as `MailboxQuotaRecalcJob.findAllPages()`. */
const MESSAGE_PAGE_SIZE = 500;

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
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseLabelRoute<T extends Label, M extends Message> extends BaseScopedChildRoute<T> {
    protected readonly scopeProperty: string = "mailboxUid";

    /** Supplied by the Mongo/SQL concrete subclasses so `delete()` can clean up references to a deleted
     * label without depending on either backend directly. */
    protected abstract messageClass: any;

    private messageRepo?: RecoverableRepoUtils<M>;

    private async getMessageRepo(): Promise<RecoverableRepoUtils<M>> {
        if (!this.messageRepo) {
            this.messageRepo = await this._objectFactory!.newInstance(RecoverableRepoUtils, {
                name: this.messageClass.name,
                args: [this.messageClass],
            });
        }
        return this.messageRepo;
    }

    /**
     * Strips `labelUid` from `labelUids` on every message in `mailboxUid` that still carries it. Runs after
     * the `Label` itself is already gone, so this operates with `ignoreACL: true` throughout (the caller's
     * permission to delete the label was already established by `super.delete()`) and reads/writes every
     * page of the mailbox's messages rather than just the first (see class doc comment).
     */
    private async cleanUpDeletedLabel(mailboxUid: string, labelUid: string): Promise<void> {
        const repo: RecoverableRepoUtils<M> = await this.getMessageRepo();
        for (let page = 0; ; page++) {
            const options: RepoFindOptions = { limit: MESSAGE_PAGE_SIZE, page, ignoreACL: true };
            const batch: M[] = await repo.find({ mailboxUid, limit: MESSAGE_PAGE_SIZE, page } as any, options);
            for (const message of batch) {
                const labelUids: string[] = message.labelUids ?? [];
                if (labelUids.includes(labelUid)) {
                    await repo.update(
                        {
                            uid: message.uid,
                            version: message.version,
                            labelUids: labelUids.filter((uid) => uid !== labelUid),
                        } as Partial<M>,
                        message,
                        { ignoreACL: true },
                    );
                }
            }
            if (batch.length < MESSAGE_PAGE_SIZE) {
                break;
            }
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
            await this.cleanUpDeletedLabel(existing.mailboxUid, existing.uid);
        }
    }
}
