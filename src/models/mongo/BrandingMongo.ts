///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BaseMongoEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { Branding } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * Implementation of the `Branding` interface for storage in a MongoDB database. If SQL is desired, please use
 * `models.sql.BrandingSQL` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("mongo")
@Entity()
@Description("This deployment's custom branding - logo, title/company, stylesheet, and web-client UI chrome.")
@Protect(
    {
        uid: "Branding",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class BrandingMongo extends BaseMongoEntity implements Branding {
    @Column()
    @Description("The company/organization name shown by the web client.")
    public companyName: string = "";

    @Column()
    @Description("Browser-tab / product title shown by the web client.")
    public title: string = "";

    @Column({ nullable: true })
    @Description("The URL a client should render as the logo.")
    @Nullable
    public logoUrl?: string;

    @Column({ nullable: true })
    @Description("Internal - set only when logoUrl currently points at an uploaded blob.")
    @Nullable
    public logoBlobKey?: string;

    @Column({ nullable: true })
    @Description("Internal - the content-type to serve the uploaded logo back with.")
    @Nullable
    public logoContentType?: string;

    @Column({ nullable: true })
    @Description("The URL a client should render as the stylesheet.")
    @Nullable
    public stylesheetUrl?: string;

    @Column({ nullable: true })
    @Description("Internal - set only when stylesheetUrl currently points at an uploaded blob.")
    @Nullable
    public stylesheetBlobKey?: string;

    @Column({ nullable: true })
    @Description("Internal - the content-type to serve the uploaded stylesheet back with.")
    @Nullable
    public stylesheetContentType?: string;

    @Column({ nullable: true })
    @Description("Free-form UI chrome the web client renders above the mail app.")
    @Nullable
    public headerHtml?: string;

    @Column({ nullable: true })
    @Description("Free-form UI chrome the web client renders below the mail app.")
    @Nullable
    public footerHtml?: string;

    constructor(other?: Partial<BrandingMongo>) {
        super(other);

        if (other) {
            this.companyName = other.companyName !== undefined ? other.companyName : this.companyName;
            this.title = other.title !== undefined ? other.title : this.title;
            this.logoUrl = "logoUrl" in other ? other.logoUrl : this.logoUrl;
            this.logoBlobKey = "logoBlobKey" in other ? other.logoBlobKey : this.logoBlobKey;
            this.logoContentType = "logoContentType" in other ? other.logoContentType : this.logoContentType;
            this.stylesheetUrl = "stylesheetUrl" in other ? other.stylesheetUrl : this.stylesheetUrl;
            this.stylesheetBlobKey = "stylesheetBlobKey" in other ? other.stylesheetBlobKey : this.stylesheetBlobKey;
            this.stylesheetContentType = "stylesheetContentType" in other ? other.stylesheetContentType : this.stylesheetContentType;
            this.headerHtml = "headerHtml" in other ? other.headerHtml : this.headerHtml;
            this.footerHtml = "footerHtml" in other ? other.footerHtml : this.footerHtml;
        }
    }
}
