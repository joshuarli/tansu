import { defineConfig } from "oxlint";

export default defineConfig({
  ignorePatterns: [
    "web/dist/**",
    "web/ts/api.generated.ts",
    "web/ts/editor/vendor/atomic/**",
    "web/ts/editor/vendor/jsquash-webp/codec/enc/webp_enc.js",
    "oxlint.config.mjs",
    "vitest*.config.ts",
  ],
  env: { browser: true },
  plugins: ["eslint", "unicorn", "typescript", "import", "promise", "vitest"],
  categories: {
    correctness: "error",
    suspicious: "error",
    perf: "error",
    pedantic: "off",
    style: "error",
    restriction: "error",
    nursery: "off",
  },
  rules: {
    "eslint/one-var": "off",
    "eslint/prefer-named-capture-group": "off",
    "typescript/method-signature-style": "off",
    "unicorn/import-style": "off",
    "unicorn/max-nested-calls": "off",
    "unicorn/prefer-dom-node-text-content": "off",
    "vitest/expect-expect": "off",
    "vitest/padding-around-test-blocks": "off",

    "typescript/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    "no-unused-vars": "off",

    "no-undef": "off",

    "no-loop-func": "off",

    "unicorn/escape-case": "off",

    "no-ternary": "off",
    "no-nested-ternary": "off",

    "no-undefined": "off",

    "import/no-named-export": "off",
    "import/prefer-default-export": "off",
    "import/no-default-export": "off",
    "import/no-namespace": "off",

    "import/consistent-type-specifier-style": "off",

    "sort-imports": "off",
    "import/first": "off",
    "import/exports-last": "off",
    "import/group-exports": "off",

    "import/unambiguous": "off",

    "import/no-relative-parent-imports": "off",

    "import/max-dependencies": "off",

    "import/no-nodejs-modules": "off",

    "import/no-unassigned-import": "off",

    complexity: "off",
    "max-depth": "off",
    "max-lines": "off",
    "max-lines-per-function": "off",
    "max-params": "off",
    "max-statements": "off",
    "jest/max-expects": "off",

    "id-length": "off",

    "no-magic-numbers": "off",

    "sort-keys": "off",
    "sort-vars": "off",

    curly: "off",

    "func-style": "off",

    "init-declarations": "off",

    "capitalized-comments": "off",
    "no-inline-comments": "off",

    "jest/no-hooks": "off",
    "jest/require-hook": "off",

    "jest/prefer-lowercase-title": "off",
    "jest/padding-around-test-blocks": "off",
    "jest/require-to-throw-message": "off",
    "jest/require-top-level-describe": "off",

    "vitest/prefer-expect-assertions": "off",
    "vitest/max-expects": "off",
    "vitest/no-conditional-in-test": "off",
    "vitest/no-conditional-expect": "off",
    "vitest/no-hooks": "off",
    "vitest/prefer-hooks-in-order": "off",
    "vitest/require-hook": "off",
    "vitest/no-importing-vitest-globals": "off",

    "eslint/prefer-arrow-callback": "off",
    "prefer-arrow-callback": "off",
    "eslint/func-names": "off",
    "func-names": "off",

    "vitest/prefer-called-with": "off",

    "vitest/prefer-lowercase-title": "off",

    "vitest/require-test-timeout": "off",
    "vitest/require-mock-type-parameters": "off",

    "vitest/prefer-describe-function-title": "off",

    "vitest/prefer-strict-boolean-matchers": "off",

    "promise/avoid-new": "off",

    "promise/param-names": "off",

    "promise/prefer-await-to-then": "off",
    "promise/prefer-await-to-callbacks": "off",
    "promise/always-return": "off",

    "no-plusplus": "off",

    "no-continue": "off",

    "no-negated-condition": "off",
    "eslint/no-negated-condition": "off",

    "unicorn/no-null": "off",
    "unicorn/no-useless-spread": "off",
    "unicorn/no-useless-undefined": "off",
    "unicorn/prefer-at": "off",
    "unicorn/prefer-dom-node-remove": "off",
    "unicorn/filename-case": "off",
    "unicorn/no-array-for-each": "off",
    "unicorn/no-await-expression-member": "off",
    "unicorn/no-nested-ternary": "off",
    "unicorn/prefer-spread": "off",
    "new-cap": "off",

    "typescript/no-non-null-assertion": "off",

    "class-methods-use-this": "off",

    "require-await": "off",

    "no-void": "off",

    "no-use-before-define": "off",

    "no-promise-executor-return": "off",

    "unicorn/prefer-global-this": "off",

    "unicorn/prefer-top-level-await": "off",

    "unicorn/no-process-exit": "off",

    "typescript/explicit-function-return-type": "off",
    "typescript/explicit-module-boundary-types": "off",

    "no-console": "off",

    "no-bitwise": "off",

    "no-alert": "off",

    "unicorn/consistent-function-scoping": "off",

    "unicorn/no-array-callback-reference": "off",

    "eslint/prefer-destructuring": "off",
    "prefer-destructuring": "off",

    "consistent-type-definitions": "off",

    "unicorn/number-literal-case": "off",

    "unicorn/prefer-add-event-listener": "off",
    "unicorn/require-module-specifiers": "off",
    "no-await-in-loop": "off",

    "no-shadow": "off",
    "eslint/no-shadow": "off",
    "unicorn/prefer-ternary": "off",
    "typescript/explicit-member-accessibility": "off",
    "eslint/no-underscore-dangle": "off",
    "no-underscore-dangle": "off",
    "eslint/default-case": "off",
    "default-case": "off",
    "unicorn/prefer-modern-dom-apis": "off",
    "typescript/parameter-properties": "off",
    "parameter-properties": "off",
    "typescript/array-type": "off",
    "array-type": "off",
    "vitest/prefer-importing-vitest-globals": "off",

    "no-new-func": "off",
    "eslint/no-new-func": "off",

    "eslint/no-unmodified-loop-condition": "off",
    "no-unmodified-loop-condition": "off",

    "numeric-separators-style": "off",
  },
  overrides: [
    {
      files: ["**/*.test.ts", "**/e2e/**/*.ts", "**/test-helper.ts", "**/search-cli.ts"],
      rules: {
        "no-empty-function": "off",
      },
    },
    {
      files: ["**/e2e/**/*.ts"],
      rules: {
        "typescript/no-explicit-any": "off",
        "typescript/no-this-alias": "off",
        "unicorn/no-this-assignment": "off",
        "promise/no-multiple-resolved": "off",
        "max-classes-per-file": "off",
        "no-param-reassign": "off",
        "unicorn/prefer-math-trunc": "off",
      },
    },
    {
      files: ["vitest.config.ts", "vitest.*.config.ts", "vite.config.ts", "vite.*.config.ts"],
      rules: {
        "import/no-default-export": "off",
      },
    },
    {
      files: ["web/ts/e2e/global-setup.ts"],
      rules: {
        "import/no-default-export": "off",
      },
    },
    {
      files: ["**/*.tsx"],
      rules: {
        "no-unassigned-vars": "off",
      },
    },
    {
      files: ["**/*.test.ts", "**/*.test.tsx"],
      rules: {
        "vitest/prefer-called-once": "off",
        "vitest/prefer-called-with": "off",
      },
    },
  ],
});
