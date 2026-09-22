///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BaseMongoEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { AppearanceBackground, AppearanceColors, AppearanceMode, AppearancePreferences } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * Implementation of the `AppearancePreferences` interface for storage in a MongoDB database. If SQL is desired, please
 * use `models.sql.AppearancePreferencesSQL` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("mongo")
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
export class AppearancePreferencesMongo extends BaseMongoEntity implements AppearancePreferences {
    @Column()
    @Description("The uid of the user these preferences belong to.")
    public userUid: string = "";

    @Column()
    @Description("How the web client chooses between its light and dark themes.")
    public mode: AppearanceMode = "system";

    @Column({ nullable: true })
    @Description("The colour overrides the user chose (`#rrggbb`); absent keys use the application's own colours.")
    @Nullable
    public colors?: AppearanceColors | null;

    @Column({ nullable: true })
    @Description("The user's window background.")
    @Nullable
    public background?: AppearanceBackground | null;

    @Column({ nullable: true })
    @Description("Internal - the content type sniffed from the uploaded background image.")
    @Nullable
    public backgroundContentType?: string | null;

    constructor(other?: Partial<AppearancePreferencesMongo>) {
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
