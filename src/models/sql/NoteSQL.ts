///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ACLAction, BaseEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { ObjectDecorators } from "@rapidrest/core";
import { Note } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Nullable } = ObjectDecorators;
const { Column, Entity, Index } = PersistenceDecorators;

/**
 * Implementation of the `Note` interface for storage in a SQL database. If MongoDB is desired, please use
 * `models.mongo.NoteMongo` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@Description("Defines a single free-form note stored in a `Folder` of type `NOTES`.")
@Index("note_folder", ["folderUid"])
@Protect(
    {
        uid: "Note",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class NoteSQL extends BaseEntity implements Note {
    @Column()
    @Description("The unique identifier of the `Mailbox` this note belongs to.")
    public mailboxUid: string = "";

    @Column()
    @Description("The unique identifier of the `Folder` (of type `NOTES`) this note resides in.")
    public folderUid: string = "";

    @Column()
    @Description("The title of the note.")
    public title: string = "";

    @Column()
    @Description("The body content of the note.")
    public body: string = "";

    @Column({ nullable: true })
    @Description("An optional display color hint (e.g. a hex code) for the note, as commonly supported by note UIs.")
    @Nullable
    public color?: string;

    constructor(other?: Partial<NoteSQL>) {
        super(other);

        if (other) {
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.folderUid = other.folderUid !== undefined ? other.folderUid : this.folderUid;
            this.title = other.title !== undefined ? other.title : this.title;
            this.body = other.body !== undefined ? other.body : this.body;
            this.color = "color" in other ? other.color : this.color;
        }
    }
}
