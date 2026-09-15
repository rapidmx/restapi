///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { PluginManifest, PluginUiApp } from "../../src/models/types.js";
import {
    findPluginUiMountConflicts,
    MAX_PLUGIN_UI_APPS,
    MAX_PLUGIN_UI_LABEL_LENGTH,
    MAX_PLUGIN_UI_NAV_ITEMS,
    parsePluginUi,
    pluginUiMountsOverlap,
    PLUGIN_UI_HOSTS,
    RESERVED_PLUGIN_UI_MOUNTS,
} from "../../src/plugins/PluginUiUtils.js";

const BOOK: PluginUiApp = { id: "book", host: "public", mount: "/book", dir: "apps/book" };
const BOOKING_TYPES: PluginUiApp = { id: "booking-types", host: "www", mount: "/settings/booking-types", dir: "apps/settings-booking-types" };

const appError = (ui: any): string => parsePluginUi({ apps: [ui] }) as string;
const app = (fields: Partial<PluginUiApp> & Record<string, unknown>): any => ({ ...BOOK, ...fields });

describe("parsePluginUi", () => {
    it("returns a valid ui block with only its known fields", () => {
        const ui = {
            apps: [{ ...BOOK, extra: 1 }, BOOKING_TYPES],
            settingsSections: [{ id: "booking-types", label: "Booking Links", href: "/settings/booking-types", extra: true }],
            adminNav: [{ id: "bookings", label: "Bookings", href: "/admin/bookings/all", icon: "HiOutlineCalendarDays" }],
            appRail: [{ id: "book", label: "Book", href: "/book" }],
            unknown: "dropped",
        };
        expect(parsePluginUi(ui)).toEqual({
            apps: [BOOK, BOOKING_TYPES],
            settingsSections: [{ id: "booking-types", label: "Booking Links", href: "/settings/booking-types" }],
            adminNav: [{ id: "bookings", label: "Bookings", href: "/admin/bookings/all", icon: "HiOutlineCalendarDays" }],
            appRail: [{ id: "book", label: "Book", href: "/book" }],
        });
    });

    it("keeps empty lists and leaves out lists that aren't given", () => {
        expect(parsePluginUi({})).toEqual({});
        expect(parsePluginUi({ adminNav: [] })).toEqual({ adminNav: [] });
    });

    it("requires an object", () => {
        for (const ui of [true, "ui", [], 0]) {
            expect(parsePluginUi(ui)).toBe("This plugin's manifest ui must be an object.");
        }
    });

    it("requires each list to be a list of bounded length", () => {
        expect(parsePluginUi({ apps: {} })).toBe("This plugin's manifest ui.apps must be a list.");
        expect(parsePluginUi({ appRail: "x" })).toBe("This plugin's manifest ui.appRail must be a list.");
        const apps = Array.from({ length: MAX_PLUGIN_UI_APPS + 1 }, (_, i) => app({ id: `a${i}`, mount: `/a${i}` }));
        expect(parsePluginUi({ apps })).toBe(`This plugin's manifest ui.apps may list at most ${MAX_PLUGIN_UI_APPS} apps.`);
        expect(parsePluginUi({ apps: apps.slice(0, MAX_PLUGIN_UI_APPS) })).toEqual({ apps: apps.slice(0, MAX_PLUGIN_UI_APPS) });
        const items = Array.from({ length: MAX_PLUGIN_UI_NAV_ITEMS + 1 }, (_, i) => ({ id: `s${i}`, label: "S", href: `/settings/s${i}` }));
        expect(parsePluginUi({ settingsSections: items })).toBe(`This plugin's manifest ui.settingsSections may list at most ${MAX_PLUGIN_UI_NAV_ITEMS} entries.`);
    });

    describe("apps", () => {
        it("needs each app to be an object", () => {
            for (const entry of [null, "book", [BOOK]]) {
                expect(appError(entry)).toBe("This plugin's manifest has an invalid ui.apps app: every app needs an id, host, mount and dir.");
            }
        });

        it("needs a lowercase slug id, unique among the apps", () => {
            for (const id of [undefined, "", "Book", "book_types", "-book", "book-", "book--types", "bo ok", "a".repeat(65), 7]) {
                expect(appError(app({ id: id as any }))).toMatch(/isn't a valid app id \(a lowercase slug such as booking-types\)\.$/);
            }
            expect(parsePluginUi({ apps: [app({ id: "a".repeat(64) })] })).not.toBeTypeOf("string");
            expect(parsePluginUi({ apps: [BOOK, { ...BOOKING_TYPES, id: "book" }] })).toBe(
                "This plugin's manifest has an invalid ui.apps app: 'book' is declared more than once.",
            );
        });

        it("needs a known host", () => {
            expect(PLUGIN_UI_HOSTS).toEqual(["public", "www", "admin", "escrow"]);
            for (const host of [undefined, "WWW", "api", "toString"]) {
                expect(appError(app({ host: host as any }))).toBe(
                    `This plugin's manifest has an invalid ui.apps app: 'book' has an unknown host ${JSON.stringify(host)}. It must be one of: public, www, admin, escrow.`,
                );
            }
        });

        it("needs dir to be a relative POSIX path inside the package", () => {
            const bad = [undefined, "", "/apps/book", "C:/apps/book", "C:apps", "apps\\book", "apps/../book", "../book", "./apps", "apps/.", "apps//book", "apps/book/", ".hidden", "apps/b ok", "a".repeat(201), 3];
            for (const dir of bad) {
                expect(appError(app({ dir: dir as any }))).toBe(
                    `This plugin's manifest has an invalid ui.apps app: 'book' has dir ${JSON.stringify(dir)}, which isn't a relative path inside the package.`,
                );
            }
            for (const dir of ["apps", "apps/book", "dist-src/My_App.v2/pages", "a".repeat(200)]) {
                expect(parsePluginUi({ apps: [app({ dir })] })).toEqual({ apps: [app({ dir })] });
            }
        });

        it("needs a normalized mount of slug segments", () => {
            for (const mount of [undefined, "", "/", "book", "/book/", "//book", "/Book", "/bo ok", "/book/../x", "/./book", "/book?x", "/b%6Fok", "/book.html", `/${"a".repeat(200)}`, 1]) {
                expect(appError(app({ mount: mount as any }))).toBe(
                    `This plugin's manifest has an invalid ui.apps app: 'book' mounts at ${JSON.stringify(mount)}, but a public app must mount at /<name> (lowercase letters, digits and dashes).`,
                );
            }
        });

        it("matches the mount to its host", () => {
            const accepted: [string, string][] = [
                ["public", "/book"],
                ["www", "/notes"],
                ["www", "/settings/booking-types"],
                ["admin", "/admin/bookings"],
                ["escrow", "/escrow/holds"],
            ];
            for (const [host, mount] of accepted) {
                expect(parsePluginUi({ apps: [app({ host: host as any, mount })] })).toEqual({ apps: [app({ host: host as any, mount })] });
            }
            const refused: [string, string, string][] = [
                ["public", "/book/manage", "/<name>"],
                ["public", "/settings/book", "/<name>"],
                ["www", "/notes/list", "/<name> or /settings/<name>"],
                ["www", "/settings/booking/types", "/<name> or /settings/<name>"],
                ["www", "/admin/notes", "/<name> or /settings/<name>"],
                ["admin", "/bookings", "/admin/<name>"],
                ["admin", "/admin/bookings/all", "/admin/<name>"],
                ["admin", "/escrow/bookings", "/admin/<name>"],
                ["escrow", "/escrow", "/escrow/<name>"],
                ["escrow", "/escrow/holds/open", "/escrow/<name>"],
                ["escrow", "/holds", "/escrow/<name>"],
            ];
            for (const [host, mount, shape] of refused) {
                expect(appError(app({ host: host as any, mount }))).toBe(
                    `This plugin's manifest has an invalid ui.apps app: 'book' mounts at "${mount}", but a ${host} app must mount at ${shape} (lowercase letters, digits and dashes).`,
                );
            }
        });

        it("refuses every reserved mount its host's shape allows", () => {
            const hostFor = (mount: string): string => {
                const [first, ...rest] = mount.slice(1).split("/");
                if (rest.length === 0) {
                    return "www";
                }
                return first === "settings" ? "www" : first;
            };
            let checked = 0;
            for (const mount of RESERVED_PLUGIN_UI_MOUNTS) {
                const error = appError(app({ host: hostFor(mount) as any, mount }));
                if (/^\/[a-z0-9-/]+$/.test(mount)) {
                    expect(error).toBe(`This plugin's manifest has an invalid ui.apps app: 'book' mounts at ${mount}, which is reserved for the server's own pages.`);
                    checked++;
                } else {
                    // `/.well-known`, `/__rapidrest__` and `/favicon.ico` can't even be written as a mount.
                    expect(error).toMatch(/must mount at/);
                }
            }
            expect(checked).toBeGreaterThan(30);
            for (const mount of ["/api", "/assets", "/admin", "/escrow", "/settings", "/calendar"]) {
                expect(appError(app({ mount }))).toMatch(/which is reserved for the server's own pages\.$/);
            }
            // Booking is moving into a plugin, so its paths stay free.
            expect(parsePluginUi({ apps: [BOOK, BOOKING_TYPES] })).toEqual({ apps: [BOOK, BOOKING_TYPES] });
        });

        it("refuses two apps of the same plugin at the same mount", () => {
            expect(parsePluginUi({ apps: [BOOK, { ...BOOKING_TYPES, host: "www", mount: "/book" }] })).toBe(
                "This plugin's manifest has an invalid ui.apps app: 'booking-types' mounts at /book, which overlaps 'book' at /book.",
            );
        });
    });

    describe("navigation entries", () => {
        const entry = (fields: Record<string, unknown>): any => ({ id: "booking-types", label: "Booking Links", href: "/settings/booking-types", ...fields });
        const sectionError = (fields: Record<string, unknown>): string => parsePluginUi({ settingsSections: [entry(fields)] }) as string;
        const prefix = "This plugin's manifest has an invalid ui.settingsSections entry: ";

        it("needs each entry to be an object", () => {
            for (const item of [null, 1, []]) {
                expect(parsePluginUi({ adminNav: [item] })).toBe("This plugin's manifest has an invalid ui.adminNav entry: every entry needs an id, label and href.");
            }
        });

        it("needs a lowercase slug id, unique within its list", () => {
            expect(sectionError({ id: "Booking" })).toBe(`${prefix}"Booking" isn't a valid entry id (a lowercase slug such as booking-types).`);
            expect(sectionError({ id: undefined })).toBe(`${prefix}undefined isn't a valid entry id (a lowercase slug such as booking-types).`);
            expect(parsePluginUi({ settingsSections: [entry({}), entry({ href: "/settings/other" })] })).toBe(`${prefix}'booking-types' is declared more than once.`);
            // The same id in different lists is fine.
            expect(parsePluginUi({ settingsSections: [entry({})], appRail: [entry({ href: "/book" })] })).not.toBeTypeOf("string");
        });

        it("needs a non-blank, bounded label", () => {
            for (const label of [undefined, "", "   ", 5, "x".repeat(MAX_PLUGIN_UI_LABEL_LENGTH + 1)]) {
                expect(sectionError({ label })).toBe(`${prefix}'booking-types' needs a label of 1 to ${MAX_PLUGIN_UI_LABEL_LENGTH} characters.`);
            }
            expect(parsePluginUi({ settingsSections: [entry({ label: "x".repeat(MAX_PLUGIN_UI_LABEL_LENGTH) })] })).not.toBeTypeOf("string");
        });

        it("needs each href under its list's prefix", () => {
            const cases: [string, string, string[], string[]][] = [
                ["settingsSections", "under /settings/", ["/settings/booking-types", "/settings/booking/edit"], ["/settings", "/settingsx/a", "/admin/x", "/book"]],
                ["adminNav", "under /admin/", ["/admin/bookings", "/admin/bookings/all"], ["/admin", "/administrator/x", "/settings/x", "/escrow/x"]],
                ["appRail", "outside /admin and /escrow", ["/book", "/notes/today", "/settings/x", "/administrator"], ["/admin", "/admin/x", "/escrow", "/escrow/x"]],
            ];
            for (const [key, rule, good, bad] of cases) {
                for (const href of good) {
                    expect(parsePluginUi({ [key]: [entry({ href })] })).toEqual({ [key]: [entry({ href })] });
                }
                for (const href of [...bad, undefined, "", "/", "settings/x", "//evil.example/settings/x", "https://evil.example/", "/settings/x/", "/settings/../admin", "/settings/X", "javascript:alert(1)", 7]) {
                    expect(parsePluginUi({ [key]: [entry({ href })] })).toBe(
                        `This plugin's manifest has an invalid ui.${key} entry: 'booking-types' links to ${JSON.stringify(href)}, but its href must be a path ${rule} (lowercase letters, digits and dashes).`,
                    );
                }
            }
        });

        it("accepts an optional react-icons/hi2 icon name", () => {
            expect(parsePluginUi({ appRail: [entry({ href: "/book", icon: "HiCalendar" })] })).toEqual({ appRail: [entry({ href: "/book", icon: "HiCalendar" })] });
            for (const icon of ["", "FaCalendar", "hiCalendar", "Hi", "Hi-Calendar", `Hi${"A".repeat(63)}`, 3, null]) {
                expect(parsePluginUi({ appRail: [entry({ href: "/book", icon })] })).toBe(
                    `This plugin's manifest has an invalid ui.appRail entry: 'booking-types' has icon ${JSON.stringify(icon)}, which isn't a react-icons/hi2 icon name such as HiOutlineCalendarDays.`,
                );
            }
            expect(parsePluginUi({ appRail: [entry({ href: "/book", icon: `Hi${"A".repeat(62)}` })] })).not.toBeTypeOf("string");
        });
    });
});

describe("pluginUiMountsOverlap", () => {
    it("matches the same path and paths beneath one another, on segment boundaries only", () => {
        expect(pluginUiMountsOverlap("/book", "/book")).toBe(true);
        expect(pluginUiMountsOverlap("/book", "/book/manage")).toBe(true);
        expect(pluginUiMountsOverlap("/book/manage", "/book")).toBe(true);
        expect(pluginUiMountsOverlap("/book", "/booking")).toBe(false);
        expect(pluginUiMountsOverlap("/settings/a", "/admin/a")).toBe(false);
    });
});

describe("findPluginUiMountConflicts", () => {
    const withApps = (displayName: string, ...apps: Partial<PluginUiApp>[]): PluginManifest => ({
        apiVersion: 1,
        displayName,
        ui: { apps: apps.map((fields, i) => ({ ...BOOK, id: `app${i}`, ...fields })) },
    });

    it("reports the later plugin of each overlapping pair, across hosts", () => {
        const plugins = [
            { name: "@rapidmx/booking-plugin", manifest: withApps("Booking", BOOK, BOOKING_TYPES) },
            { name: "@rapidmx/calendly-plugin", manifest: withApps("Calendly", { host: "www", mount: "/book" }, { mount: "/other" }) },
            { name: "@rapidmx/nested", manifest: withApps("Nested", { mount: "/settings/booking-types/extra" }) },
            { name: "@rapidmx/parent", manifest: withApps("Parent", { mount: "/other/deeper" }) },
        ];
        expect(findPluginUiMountConflicts(plugins)).toEqual([
            {
                name: "@rapidmx/calendly-plugin",
                mount: "/book",
                otherName: "@rapidmx/booking-plugin",
                otherMount: "/book",
                message: "Calendly and Booking both serve pages at /book.",
            },
            {
                name: "@rapidmx/nested",
                mount: "/settings/booking-types/extra",
                otherName: "@rapidmx/booking-plugin",
                otherMount: "/settings/booking-types",
                message: "Nested's pages at /settings/booking-types/extra overlap Booking's pages at /settings/booking-types.",
            },
            {
                name: "@rapidmx/parent",
                mount: "/other/deeper",
                otherName: "@rapidmx/calendly-plugin",
                otherMount: "/other",
                message: "Parent's pages at /other/deeper overlap Calendly's pages at /other.",
            },
        ]);
    });

    it("ignores plugins without UI apps, a plugin listed twice, and labels a plugin without a manifest by name", () => {
        const booking = { name: "@rapidmx/booking-plugin", manifest: withApps("Booking", BOOK) };
        expect(
            findPluginUiMountConflicts([
                booking,
                { name: "none" },
                { name: "no-ui", manifest: { apiVersion: 1, displayName: "No UI" } },
                { name: "nav-only", manifest: { apiVersion: 1, displayName: "Nav", ui: { appRail: [] } } },
                booking,
            ]),
        ).toEqual([]);
        const bare = { name: "bare", manifest: { ...withApps("x", BOOK), displayName: undefined as any } };
        expect(findPluginUiMountConflicts([booking, bare]).map((c) => c.message)).toEqual(["bare and Booking both serve pages at /book."]);
    });
});
