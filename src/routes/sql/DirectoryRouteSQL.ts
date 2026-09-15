///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { Brackets, type SelectQueryBuilder, type Repository as TypeOrmRepository, type WhereExpressionBuilder } from "typeorm";
import { DatabaseDecorators } from "@rapidrest/service-core";
import { ContactSQL, DataSubjectErasureRequestSQL, DistributionListSQL, FolderSQL, MailboxSQL } from "../../sql.js";
import { BaseDirectoryRoute, escapeDirectoryLike } from "../BaseDirectoryRoute.js";
const { Repository } = DatabaseDecorators;

/**
 * ANDs one bracketed condition per term onto `qb`: the term at the start of a word (the value's start, or after a space
 * or hyphen) of any of `nameColumns`, or at the start of any of `prefixColumns`. Columns are lowercased and the terms
 * (already lowercase) are `LIKE`-escaped, so user text only ever matches itself. `prefixPattern` builds the escaped
 * pattern for a prefix column from the term. Parameter names are unique per term and column.
 */
function andTerms<T extends object>(
    qb: SelectQueryBuilder<T>,
    terms: string[],
    nameColumns: string[],
    prefixColumns: string[],
    prefixPattern: (term: string) => string = (term) => `${escapeDirectoryLike(term)}%`,
): SelectQueryBuilder<T> {
    terms.forEach((term, t) => {
        const escaped: string = escapeDirectoryLike(term);
        qb.andWhere(
            new Brackets((where: WhereExpressionBuilder) => {
                const like = (column: string, name: string, pattern: string): void => {
                    where.orWhere(`LOWER(${column}) LIKE :${name} ESCAPE '\\'`, { [name]: pattern });
                };
                nameColumns.forEach((column, c) => {
                    like(column, `t${t}n${c}s`, `${escaped}%`);
                    like(column, `t${t}n${c}w`, `% ${escaped}%`);
                    like(column, `t${t}n${c}h`, `%-${escaped}%`);
                });
                prefixColumns.forEach((column, c) => like(column, `t${t}p${c}`, prefixPattern(term)));
            }),
        );
    });
    return qb;
}

export class DirectoryRouteSQL extends BaseDirectoryRoute<MailboxSQL, FolderSQL> {
    protected mailboxClass: any = MailboxSQL;
    protected folderClass: any = FolderSQL;
    protected erasureRequestClass: any = DataSubjectErasureRequestSQL;

    @Repository(MailboxSQL)
    private mailboxTable?: TypeOrmRepository<MailboxSQL>;

    @Repository(DistributionListSQL)
    private listTable?: TypeOrmRepository<DistributionListSQL>;

    @Repository(ContactSQL)
    private contactTable?: TypeOrmRepository<ContactSQL>;

    protected async findMailboxCandidates(terms: string[], limit: number): Promise<MailboxSQL[]> {
        const qb = this.mailboxTable!.createQueryBuilder("e").select([
            "e.uid",
            "e.displayName",
            "e.primarySmtpAddress",
            "e.ownerUserUid",
            "e.isResource",
            "e.resourceType",
        ]);
        return await andTerms(qb, terms, ["e.displayName"], ["e.primarySmtpAddress"])
            .orderBy("e.displayName", "ASC")
            .addOrderBy("e.primarySmtpAddress", "ASC")
            .take(limit)
            .getMany();
    }

    protected async findDistributionListCandidates(terms: string[], limit: number): Promise<DistributionListSQL[]> {
        const qb = this.listTable!.createQueryBuilder("e")
            .select(["e.uid", "e.name", "e.primarySmtpAddress"])
            .where("e.deleted = :deleted", { deleted: false });
        return await andTerms(qb, terms, ["e.name"], ["e.primarySmtpAddress"])
            .orderBy("e.name", "ASC")
            .addOrderBy("e.primarySmtpAddress", "ASC")
            .take(limit)
            .getMany();
    }

    /** `emails` is a serialized `simple-json` column here, so an address prefix is matched against its serialized
     * `"address":"<term>` form - the term JSON-escaped first, as it is stored, then `LIKE`-escaped. */
    protected async findContactCandidates(folderUids: string[], terms: string[], limit: number): Promise<ContactSQL[]> {
        const qb = this.contactTable!.createQueryBuilder("e")
            .select(["e.uid", "e.displayName", "e.givenName", "e.surname", "e.emails"])
            .where("e.folderUid IN (:...folderUids)", { folderUids })
            .andWhere("e.deleted = :deleted", { deleted: false });
        const addressPattern = (term: string): string => `%"address":"${escapeDirectoryLike(JSON.stringify(term).slice(1, -1))}%`;
        return await andTerms(qb, terms, ["e.displayName", "e.givenName", "e.surname"], ["e.emails"], addressPattern)
            .orderBy("e.displayName", "ASC")
            .take(limit)
            .getMany();
    }
}
