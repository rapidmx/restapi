///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { PluginManifest, PluginUi, PluginUiApp, PluginUiHost, PluginUiNavItem } from "../models/types.js";

/** The hosts a plugin UI app can be served by - see `PluginUiHost`. */
export const PLUGIN_UI_HOSTS: readonly PluginUiHost[] = ["public", "www", "admin", "escrow"];

/** The most apps one plugin may declare. */
export const MAX_PLUGIN_UI_APPS = 16;

/** The most entries one plugin may add to each navigation list. */
export const MAX_PLUGIN_UI_NAV_ITEMS = 8;

/** The longest navigation entry label. */
export const MAX_PLUGIN_UI_LABEL_LENGTH = 64;

/**
 * URL paths a plugin UI app may never be mounted at, because the server itself answers them. A mount is refused when it
 * equals one of these.
 *
 * This list must track the server's core routes: its `@Route` paths (`server/src/{mongo,sql}/routes`), the API prefix,
 * `@rapidrest/react`'s asset and dev paths, the files in `server/public`, and every top-level page directory of
 * `@rapidmx/web-client`'s `apps/www`, `apps/admin` and `apps/escrow`. Add an entry here whenever one of those gains a
 * path. (`/book` and `/settings/booking-types` are deliberately absent: booking is served by `@rapidmx/booking-plugin`.)
 *
 * The mount shapes (`/<name>`, `/settings/<name>`, `/admin/<name>`, `/escrow/<name>`) keep every mount one segment below
 * its base, so nothing can be mounted beneath an entry here and an exact match is enough.
 */
export const RESERVED_PLUGIN_UI_MOUNTS: readonly string[] = [
    // Framework and server routes.
    "/api",
    "/assets",
    "/__rapidrest__",
    "/.well-known",
    "/internal",
    "/push",
    // `server/public`.
    "/favicon.ico",
    "/fonts",
    "/images",
    "/styles",
    // web-client `apps/www`.
    "/calendar",
    "/contacts",
    "/messages",
    "/tasks",
    "/settings",
    "/settings/auto-reply",
    "/settings/encryption",
    "/settings/filters",
    "/settings/focused-inbox",
    "/settings/labels",
    "/settings/privacy",
    "/settings/read-receipts",
    "/settings/sharing",
    "/settings/signatures",
    // web-client `apps/admin`.
    "/admin",
    "/admin/audit-log",
    "/admin/branding",
    "/admin/data-requests",
    "/admin/distribution-lists",
    "/admin/domains",
    "/admin/encryption-policy",
    "/admin/escrow-scopes",
    "/admin/ingest-queue",
    "/admin/mailbox-policy",
    "/admin/mailboxes",
    "/admin/plugins",
    "/admin/quarantine",
    "/admin/retention-policy",
    "/admin/setup",
    "/admin/transport-rules",
    // web-client `apps/escrow`.
    "/escrow",
    "/escrow/audit-log",
    "/escrow/matters",
];

/** Two UI apps of different enabled plugins whose mounts are the same, or one of which lies beneath the other. */
export interface PluginUiMountConflict {
    /** The plugin listed later. A host that keeps the first plugin to claim a path drops this one. */
    name: string;
    mount: string;
    /** The plugin listed earlier, which claimed the path first. */
    otherName: string;
    otherMount: string;
    message: string;
}

/** A lowercase slug: `booking-types`, `book`, `v2`. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const MAX_SLUG_LENGTH = 64;

/** An absolute path of slug segments: no trailing slash, no empty, `.` or `..` segment, nothing to escape. */
const SLUG_PATH_PATTERN = /^(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+$/;

const MAX_PATH_LENGTH = 200;

/** One segment of a package directory. It can't start with a dot, so `.`, `..` and hidden directories are all refused. */
const DIR_SEGMENT_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** A `react-icons/hi2` component name. */
const ICON_PATTERN = /^Hi[A-Z][A-Za-z0-9]*$/;

/** Where each host's apps may be mounted, as the path segments before the app's own name, and how that reads. */
const MOUNT_BASES: Record<PluginUiHost, { bases: string[][]; shape: string }> = {
    public: { bases: [[]], shape: "/<name>" },
    www: { bases: [[], ["settings"]], shape: "/<name> or /settings/<name>" },
    admin: { bases: [["admin"]], shape: "/admin/<name>" },
    escrow: { bases: [["escrow"]], shape: "/escrow/<name>" },
};

/** The navigation lists, with the check each entry's `href` must pass and how that reads. */
const NAV_LISTS: { key: "settingsSections" | "adminNav" | "appRail"; accepts: (segments: string[]) => boolean; rule: string }[] = [
    { key: "settingsSections", accepts: (segments) => segments.length >= 2 && segments[0] === "settings", rule: "under /settings/" },
    { key: "adminNav", accepts: (segments) => segments.length >= 2 && segments[0] === "admin", rule: "under /admin/" },
    { key: "appRail", accepts: (segments) => segments[0] !== "admin" && segments[0] !== "escrow", rule: "outside /admin and /escrow" },
];

function isSlug(value: unknown): value is string {
    return typeof value === "string" && value.length <= MAX_SLUG_LENGTH && SLUG_PATTERN.test(value);
}

/** The segments of `value` when it's an absolute path of slug segments, otherwise `undefined`. */
function slugPathSegments(value: unknown): string[] | undefined {
    return typeof value === "string" && value.length <= MAX_PATH_LENGTH && SLUG_PATH_PATTERN.test(value) ? value.slice(1).split("/") : undefined;
}

/** Whether `dir` is a relative POSIX path that stays inside the package. */
function isPackageDir(dir: unknown): dir is string {
    return typeof dir === "string" && dir.length <= MAX_PATH_LENGTH && dir.split("/").every((segment) => DIR_SEGMENT_PATTERN.test(segment));
}

/** Whether two mounts are the same path or one lies beneath the other. */
export function pluginUiMountsOverlap(a: string, b: string): boolean {
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function checkApp(app: any, apps: PluginUiApp[]): string | PluginUiApp {
    if (!app || typeof app !== "object" || Array.isArray(app)) {
        return "every app needs an id, host, mount and dir.";
    }
    if (!isSlug(app.id)) {
        return `${JSON.stringify(app.id)} isn't a valid app id (a lowercase slug such as booking-types).`;
    }
    if (apps.some((other) => other.id === app.id)) {
        return `'${app.id}' is declared more than once.`;
    }
    if (!PLUGIN_UI_HOSTS.includes(app.host)) {
        return `'${app.id}' has an unknown host ${JSON.stringify(app.host)}. It must be one of: ${PLUGIN_UI_HOSTS.join(", ")}.`;
    }
    if (!isPackageDir(app.dir)) {
        return `'${app.id}' has dir ${JSON.stringify(app.dir)}, which isn't a relative path inside the package.`;
    }
    const host: PluginUiHost = app.host;
    const segments: string[] | undefined = slugPathSegments(app.mount);
    const { bases, shape } = MOUNT_BASES[host];
    const fits: boolean =
        !!segments && bases.some((base) => segments.length === base.length + 1 && base.every((segment, index) => segments[index] === segment));
    if (!fits) {
        return `'${app.id}' mounts at ${JSON.stringify(app.mount)}, but a ${host} app must mount at ${shape} (lowercase letters, digits and dashes).`;
    }
    const mount: string = app.mount;
    if (RESERVED_PLUGIN_UI_MOUNTS.includes(mount)) {
        return `'${app.id}' mounts at ${mount}, which is reserved for the server's own pages.`;
    }
    const clash: PluginUiApp | undefined = apps.find((other) => pluginUiMountsOverlap(other.mount, mount));
    if (clash) {
        return `'${app.id}' mounts at ${mount}, which overlaps '${clash.id}' at ${clash.mount}.`;
    }
    return { id: app.id, host, mount, dir: app.dir };
}

function checkNavItem(item: any, items: PluginUiNavItem[], list: (typeof NAV_LISTS)[number]): string | PluginUiNavItem {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
        return "every entry needs an id, label and href.";
    }
    if (!isSlug(item.id)) {
        return `${JSON.stringify(item.id)} isn't a valid entry id (a lowercase slug such as booking-types).`;
    }
    if (items.some((other) => other.id === item.id)) {
        return `'${item.id}' is declared more than once.`;
    }
    if (typeof item.label !== "string" || item.label.trim() === "" || item.label.length > MAX_PLUGIN_UI_LABEL_LENGTH) {
        return `'${item.id}' needs a label of 1 to ${MAX_PLUGIN_UI_LABEL_LENGTH} characters.`;
    }
    const segments: string[] | undefined = slugPathSegments(item.href);
    if (!segments || !list.accepts(segments)) {
        return `'${item.id}' links to ${JSON.stringify(item.href)}, but its href must be a path ${list.rule} (lowercase letters, digits and dashes).`;
    }
    if (item.icon !== undefined && (typeof item.icon !== "string" || item.icon.length > MAX_SLUG_LENGTH || !ICON_PATTERN.test(item.icon))) {
        return `'${item.id}' has icon ${JSON.stringify(item.icon)}, which isn't a react-icons/hi2 icon name such as HiOutlineCalendarDays.`;
    }
    return { id: item.id, label: item.label, href: item.href, ...(item.icon !== undefined ? { icon: item.icon } : {}) };
}

/** Reads one list of the `ui` block with `check`, returning the checked entries or the first problem as a manifest
 * error. */
function parseList<E>(
    value: unknown,
    key: string,
    [noun, plural]: [string, string],
    max: number,
    check: (entry: any, accepted: E[]) => string | E,
): E[] | string {
    if (!Array.isArray(value)) {
        return `This plugin's manifest ui.${key} must be a list.`;
    }
    if (value.length > max) {
        return `This plugin's manifest ui.${key} may list at most ${max} ${plural}.`;
    }
    const accepted: E[] = [];
    for (const entry of value) {
        const result: string | E = check(entry, accepted);
        if (typeof result === "string") {
            return `This plugin's manifest has an invalid ui.${key} ${noun}: ${result}`;
        }
        accepted.push(result);
    }
    return accepted;
}

/**
 * Validates a manifest's `ui` block and returns it with only its known fields, or an error message in
 * `parsePluginManifest()`'s style.
 *
 * `apps` lists at most `MAX_PLUGIN_UI_APPS`. Each `id` is a lowercase slug unique among the apps, `host` is one of
 * `PLUGIN_UI_HOSTS`, and `dir` is a relative POSIX path inside the package: no leading `/`, drive letter, backslash,
 * empty segment or segment starting with a dot (so no `.` or `..`). `mount` is a path of lowercase slug segments
 * matching its host: `/<name>` for `public`, `/<name>` or `/settings/<name>` for `www`, `/admin/<name>` for `admin`
 * and `/escrow/<name>` for `escrow`. Deeper mounts are refused: an app's own pages already provide nested paths, and
 * one segment keeps a plugin from mounting beneath a core page (`/admin/mailboxes/extra`). A mount may not be in
 * `RESERVED_PLUGIN_UI_MOUNTS` or overlap another of the plugin's apps.
 *
 * `settingsSections`, `adminNav` and `appRail` each list at most `MAX_PLUGIN_UI_NAV_ITEMS`. Each `id` is a lowercase
 * slug unique within its list, `label` is non-blank and at most `MAX_PLUGIN_UI_LABEL_LENGTH` characters, and `href` is
 * a path of lowercase slug segments under `/settings/`, under `/admin/`, or (app rail) outside `/admin` and `/escrow`.
 * The optional `icon` is a `react-icons/hi2` component name.
 */
export function parsePluginUi(ui: unknown): PluginUi | string {
    if (!ui || typeof ui !== "object" || Array.isArray(ui)) {
        return "This plugin's manifest ui must be an object.";
    }
    const given: any = ui;
    const result: PluginUi = {};
    if (given.apps !== undefined) {
        const apps: PluginUiApp[] | string = parseList(given.apps, "apps", ["app", "apps"], MAX_PLUGIN_UI_APPS, checkApp);
        if (typeof apps === "string") {
            return apps;
        }
        result.apps = apps;
    }
    for (const list of NAV_LISTS) {
        if (given[list.key] !== undefined) {
            const items: PluginUiNavItem[] | string = parseList(given[list.key], list.key, ["entry", "entries"], MAX_PLUGIN_UI_NAV_ITEMS, (item, accepted: PluginUiNavItem[]) =>
                checkNavItem(item, accepted, list),
            );
            if (typeof items === "string") {
                return items;
            }
            result[list.key] = items;
        }
    }
    return result;
}

/**
 * Every pair of UI apps from different plugins in `plugins` whose mounts overlap (see `pluginUiMountsOverlap()`), in
 * list order - hosts share one URL space, so apps on different hosts conflict too. Each conflict names the later plugin
 * as `name` and the earlier as `otherName`. A plugin without a `ui` block, or listed twice, conflicts with nothing.
 */
export function findPluginUiMountConflicts(plugins: { name: string; manifest?: PluginManifest }[]): PluginUiMountConflict[] {
    const conflicts: PluginUiMountConflict[] = [];
    const claimed: { name: string; label: string; mount: string }[] = [];
    for (const plugin of plugins) {
        const label: string = plugin.manifest?.displayName ?? plugin.name;
        const mounts: string[] = (plugin.manifest?.ui?.apps ?? []).map((app) => app.mount);
        for (const mount of mounts) {
            for (const other of claimed) {
                if (other.name !== plugin.name && pluginUiMountsOverlap(mount, other.mount)) {
                    conflicts.push({
                        name: plugin.name,
                        mount,
                        otherName: other.name,
                        otherMount: other.mount,
                        message:
                            mount === other.mount
                                ? `${label} and ${other.label} both serve pages at ${mount}.`
                                : `${label}'s pages at ${mount} overlap ${other.label}'s pages at ${other.mount}.`,
                    });
                }
            }
        }
        claimed.push(...mounts.map((mount) => ({ name: plugin.name, label, mount })));
    }
    return conflicts;
}
