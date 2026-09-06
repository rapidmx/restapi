import globals from "globals";
import typescriptParser from "@typescript-eslint/parser";
import pluginImport from "eslint-plugin-import";
import jsdoc from "eslint-plugin-jsdoc";
import typescriptEslint from "@typescript-eslint/eslint-plugin";
export default [
    {
        files: ["**/*.ts"],
        languageOptions: {
            ecmaVersion: 2020,
            parser: typescriptParser,
            parserOptions: {
                project: ["tsconfig.json", "./tsconfig.eslint.json"],
                sourceType: "module",
            },
            globals: {
                ...globals.browser,
            }
        },


        plugins: {
            import: pluginImport,
            jsdoc: jsdoc,
            typescript: typescriptEslint
        },
        rules: {
            "typescript/await-thenable": "error",
            "typescript/consistent-type-assertions": "error",
            "typescript/member-delimiter-style": [
                "off",
                {
                    multiline: {
                        delimiter: "none",
                        requireLast: true,
                    },
                    singleline: {
                        delimiter: "semi",
                        requireLast: false,
                    },
                },
            ],
            "typescript/naming-convention": [
                "error",
                {
                    selector: "variable",
                    format: ["camelCase", "UPPER_CASE", "PascalCase"],
                    leadingUnderscore: "allow",
                    trailingUnderscore: "forbid",
                },
            ],
            "typescript/no-empty-function": "error",
            "typescript/no-floating-promises": "error",
            "typescript/no-misused-new": "error",
            "typescript/no-unnecessary-qualifier": "error",
            "typescript/no-unnecessary-type-assertion": "error",
            "typescript/no-unused-expressions": [
                "error",
                {
                    allowTaggedTemplates: true,
                    allowShortCircuit: true,
                },
            ],
            "typescript/prefer-namespace-keyword": "error",
            "typescript/return-await": ["off", "always"],
            "typescript/semi": ["off", null],
            "typescript/triple-slash-reference": [
                "error",
                {
                    path: "always",
                    types: "prefer-import",
                    lib: "always",
                },
            ],
            "typescript/unified-signatures": "error",
            "arrow-parens": ["off", "always"],
            "brace-style": ["off", "off"],
            curly: ["error", "multi-line"],
            eqeqeq: ["error", "smart"],
            "id-denylist": [
                "error",
                "any",
                "Number",
                "number",
                "String",
                "string",
                "Boolean",
                "boolean",
                "Undefined",
                "undefined",
            ],
            "id-match": "error",
            // Does not currently support flat config "import/no-deprecated": "error",
            "jsdoc/check-alignment": "error",
            "jsdoc/check-indentation": "error",
            "jsdoc/newline-after-description": 0,
            "no-caller": "error",
            "no-cond-assign": "error",
            "no-constant-condition": "error",
            "no-control-regex": "error",
            "no-duplicate-imports": "error",
            "no-empty": "error",
            "no-empty-function": "off",
            "no-eval": "error",
            "no-fallthrough": "error",
            "no-invalid-regexp": "error",
            "no-irregular-whitespace": "off",
            "no-redeclare": "error",
            "no-regex-spaces": "error",
            "no-throw-literal": "error",
            "no-underscore-dangle": "off",
            "no-unused-expressions": "off",
            "no-unused-labels": "error",
            "no-var": "error",
            "one-var": ["error", "never"],
            "padded-blocks": [
                "off",
                {
                    blocks: "never",
                },
                {
                    allowSingleLineBlocks: true,
                },
            ],
            radix: "error",
            "space-in-parens": ["off", "never"],
            "spaced-comment": [
                "error",
                "always",
                {
                    markers: ["/"],
                    exceptions: ["/"],
                },
            ],
            "use-isnan": "error",
            "no-sparse-arrays": "error",
            "no-duplicate-case": "error",
            "handle-callback-err": "error",
            "no-empty-character-class": "error",
            "no-ex-assign": "error",
            "no-extra-boolean-cast": "error",
            "no-inner-declarations": "error",
            "no-unexpected-multiline": "error",
            "valid-typeof": ["error", { requireStringLiterals: true }],
        },
    }
];


