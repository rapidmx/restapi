///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BaseEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { AppearanceBackground, AppearanceColors, AppearanceMode, AppearancePreferences } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * Implementation of the `AppearancePreferences` interface for storage in a SQL database. If MongoDB is desired, please
 * use `models.mongo.AppearancePreferencesMongo` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@Description("A user's appearance settings for the web client - theme mode, colours and window background.")
@Index("appearancepreferences_user", ["userUid"], { unique: true })
@Protect(
    {
        uid: "AppearancePreferences",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class AppearancePreferencesSQL extends BaseEntity implements AppearancePreferences {
    @Column()
    @Description("The uid of the user these preferences belong to.")
    public userUid: string = "";

    // `type: "varchar"` is required on every string-union column - see `MessageSQL.importance`'s own comment for the
    // `emitDecoratorMetadata`/TypeORM reason.
    @Column({ type: "varchar" })
    @Description("How the web client chooses between its light and dark themes.")
    public mode: AppearanceMode = "system";

    @Column({ type: "simple-json", nullable: true })
    @Description("The colour overrides the user chose (`#rrggbb`); absent keys use the application's own colours.")
    @Nullable
    public colors?: AppearanceColors | null;

    @Column({ type: "simple-json", nullable: true })
    @Description("The user's window background.")
    @Nullable
    public background?: AppearanceBackground | null;

    @Column({ type: "varchar", nullable: true })
    @Description("Internal - the content type sniffed from the uploaded background image.")
    @Nullable
    public backgroundContentType?: string | null;

    constructor(other?: Partial<AppearancePreferencesSQL>) {
        super(other);

        if (other) {
            this.userUid = other.userUid !== undefined ? other.userUid : this.userUid;
            this.mode = other.mode !== undefined ? other.mode : this.mode;
            this.colors = "colors" in other ? other.colors : this.colors;
            this.background = "background" in other ? other.background : this.background;
            this.backgroundContentType = "backgroundContentType" in other ? other.backgroundContentType : this.backgroundContentType;
        }
    }
}
