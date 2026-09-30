///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { DatabaseDecorators, type MongoRepository } from "@rapidrest/service-core";
import { CalendarEventMongo, ContactMongo, CorrespondentMongo, DataSubjectErasureRequestMongo, DistributionListMongo, FolderMongo, MailboxMongo, MessageMongo } from "../../mongo.js";
import { BaseDirectoryRoute, escapeDirectoryRegExp } from "../BaseDirectoryRoute.js";
const { Repository } = DatabaseDecorators;

/** A case-insensitive match for `term` at the start of a word (after the start, a space or a hyphen). */
function wordPrefix(term: string): any {
    return { $regex: `(?:^|[\\s-])${escapeDirectoryRegExp(term)}`, $options: "i" };
}

/** A case-insensitive match for `term` at the start of the value. */
function prefix(term: string): any {
    return { $regex: `^${escapeDirectoryRegExp(term)}`, $options: "i" };
}

export class DirectoryRouteMongo extends BaseDirectoryRoute<MailboxMongo, FolderMongo> {
    protected mailboxClass: any = MailboxMongo;
    protected folderClass: any = FolderMongo;
    protected erasureRequestClass: any = DataSubjectErasureRequestMongo;
    protected messageClass: any = MessageMongo;
    protected calendarEventClass: any = CalendarEventMongo;
    protected correspondentClass: any = CorrespondentMongo;

    @Repository(MailboxMongo)
    private mailboxCollection?: MongoRepository<MailboxMongo>;

    @Repository(DistributionListMongo)
    private listCollection?: MongoRepository<DistributionListMongo>;

    @Repository(ContactMongo)
    private contactCollection?: MongoRepository<ContactMongo>;

    @Repository(CorrespondentMongo)
    private correspondentCollection?: MongoRepository<CorrespondentMongo>;

    protected async findMailboxCandidates(terms: string[], limit: number): Promise<MailboxMongo[]> {
        const filter: any = { $and: terms.map((term) => ({ $or: [{ displayName: wordPrefix(term) }, { primarySmtpAddress: prefix(term) }] })) };
        return await this.mailboxCollection!.find(filter, {
            projection: { uid: 1, displayName: 1, primarySmtpAddress: 1, ownerUserUid: 1, isResource: 1, resourceType: 1 },
            sort: { displayName: 1, primarySmtpAddress: 1 },
            limit,
        }).toArray();
    }

    protected async findDistributionListCandidates(terms: string[], limit: number): Promise<DistributionListMongo[]> {
        const filter: any = {
            deleted: { $ne: true },
            $and: terms.map((term) => ({ $or: [{ name: wordPrefix(term) }, { primarySmtpAddress: prefix(term) }] })),
        };
        return await this.listCollection!.find(filter, {
            projection: { name: 1, primarySmtpAddress: 1 },
            sort: { name: 1, primarySmtpAddress: 1 },
            limit,
        }).toArray();
    }

    protected async findContactCandidates(folderUids: string[], terms: string[], limit: number): Promise<ContactMongo[]> {
        const filter: any = {
            folderUid: { $in: folderUids },
            deleted: { $ne: true },
            $and: terms.map((term) => ({
                $or: [{ displayName: wordPrefix(term) }, { givenName: wordPrefix(term) }, { surname: wordPrefix(term) }, { "emails.address": prefix(term) }],
            })),
        };
        return await this.contactCollection!.find(filter, {
            projection: { displayName: 1, givenName: 1, surname: 1, emails: 1 },
            sort: { displayName: 1 },
            limit,
        }).toArray();
    }

    protected async findCorrespondentCandidates(mailboxUids: string[], terms: string[], limit: number): Promise<CorrespondentMongo[]> {
        const filter: any = {
            mailboxUid: { $in: mailboxUids },
            $and: terms.map((term) => ({ $or: [{ displayName: wordPrefix(term) }, { address: prefix(term) }] })),
        };
        return await this.correspondentCollection!.find(filter, {
            projection: { address: 1, displayName: 1, lastSeenAt: 1, count: 1 },
            sort: { lastSeenAt: -1, count: -1 },
            limit,
        }).toArray();
    }
}
