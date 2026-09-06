import { defineConfig } from "vitest/config";
import swc from "unplugin-swc";
import { resolve } from "path";

export default defineConfig({
    resolve: {
        alias: {
            "@rapidrest/service-core/dist/lib/test/request.js": resolve(
                "node_modules/@rapidrest/service-core/dist/lib/test/request.js",
            ),
            "@rapidrest/service-core/dist/lib/test/requestws.js": resolve(
                "node_modules/@rapidrest/service-core/dist/lib/test/requestws.js",
            ),
        },
    },
    ssr: {
        noExternal: ["@rapidrest/service-core", "@rapidrest/core"],
    },
    plugins: [
        swc.vite({
            jsc: {
                parser: {
                    syntax: "typescript",
                    decorators: true,
                },
                transform: {
                    decoratorMetadata: true,
                    legacyDecorator: true,
                },
                target: "es2020",
            },
        }),
    ],
    test: {
        globals: true,
        environment: "node",
        include: ["test/**/*.test.ts"],
        fileParallelism: false,
        pool: "forks",
        poolOptions: {
            forks: {
                execArgv: ["--no-experimental-strip-types"],
            },
        },
        clearMocks: true,
        coverage: {
            enabled: true,
            provider: "v8",
            include: ["src/**/*.ts"],
            exclude: ["**/node_modules/**", "**/test/**"],
            reporter: ["text", "json", "html", "lcov"],
            thresholds: {
                // The v8/istanbul branch instrumentation counts one extra, structurally-unreachable branch per
                // `@Inject`/`@Config` decorated class field - TypeScript's `emitDecoratorMetadata` emits
                // `typeof X === "undefined" ? Object : X` for each one's `design:type`, and the `Object` arm
                // can only be taken if `X` were undefined at decoration time (e.g. a circular-import TDZ),
                // which isn't a legitimate test scenario. Matches `@rapidrest/auth`'s identical carve-out.
                branches: 95,
                functions: 100,
                lines: 100,
                statements: 100,
            },
            reportsDirectory: "coverage",
        },
        reporters: ["default", "junit"],
        outputFile: {
            junit: "junit.xml",
        },
    },
});
