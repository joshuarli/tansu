import { defineConfig } from "oxlint";

export default defineConfig({
  ignorePatterns: [
    "web/ts/api.generated.ts",
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

    // TS-aware unused vars: allows _prefixed params as intentional no-ops
    "typescript/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    "no-unused-vars": "off",

    // Already caught by TypeScript
    "no-undef": "off",

    // False positive: fires on const-scoped variables in for...of loops where each iteration
    // has its own binding. ESLint docs state const loop vars are not affected by this rule.
    "no-loop-func": "off",

    // Lowercase Unicode escapes (​) are clearer than uppercase (​) — readable as-is
    "unicorn/escape-case": "off",

    // Conflicts: unicorn/prefer-ternary wins over no-ternary; unicorn covers nested-ternary too
    "no-ternary": "off",
    "no-nested-ternary": "off",

    // Conflicts: no-undefined vs unicorn/no-useless-undefined — allow undefined as a value
    "no-undefined": "off",

    // Project uses named exports throughout; these conflict with each other
    "import/no-named-export": "off",
    "import/prefer-default-export": "off",
    "import/no-default-export": "off",
    "import/no-namespace": "off",

    // Disabled: conflicts with no-import-type-side-effects; use import type { X } for type-only imports
    "import/consistent-type-specifier-style": "off",

    "sort-imports": "off",
    "import/first": "off",
    "import/exports-last": "off",
    "import/group-exports": "off",

    // Requires every file to have import/export (breaks ambient .d.ts files)
    "import/unambiguous": "off",

    // Tests need ../src/ imports
    "import/no-relative-parent-imports": "off",

    // Too many imports is not a correctness issue
    "import/max-dependencies": "off",

    // Browser source doesn't import Node modules; TS catches it if it does
    "import/no-nodejs-modules": "off",

    // Side-effect imports are sometimes legitimate
    "import/no-unassigned-import": "off",

    // Size/complexity thresholds — not defect indicators
    complexity: "off",
    "max-depth": "off",
    "max-lines": "off",
    "max-lines-per-function": "off",
    "max-params": "off",
    "max-statements": "off",
    "jest/max-expects": "off",

    // Disallows short names like i, e, el
    "id-length": "off",

    // Magic numbers are normal in tests and low-level algorithms
    "no-magic-numbers": "off",

    "sort-keys": "off",
    "sort-vars": "off",

    // Brace-less single-statement ifs are idiomatic and readable
    curly: "off",

    // Function declaration vs expression is context-dependent
    "func-style": "off",

    // Not all declarations need initialization
    "init-declarations": "off",

    // Comment style
    "capitalized-comments": "off",
    "no-inline-comments": "off",

    // beforeEach/afterEach are standard test practice
    "jest/no-hooks": "off",
    "jest/require-hook": "off",

    // Opinionated test style
    "jest/prefer-lowercase-title": "off",
    "jest/padding-around-test-blocks": "off",
    "jest/require-to-throw-message": "off",
    "jest/require-top-level-describe": "off",

    // High-noise vitest style rules; test structure is a team convention, not a lint concern
    "vitest/prefer-expect-assertions": "off",
    "vitest/max-expects": "off",
    "vitest/no-conditional-in-test": "off",
    "vitest/no-conditional-expect": "off",
    "vitest/no-hooks": "off",
    "vitest/prefer-hooks-in-order": "off",
    "vitest/require-hook": "off",
    "vitest/no-importing-vitest-globals": "off",

    // Broken autofix: vi.fn() needs function form for constructor mocks (has prototype).
    // Arrow functions break vitest's function/class detection.
    "eslint/prefer-arrow-callback": "off",
    "prefer-arrow-callback": "off",
    "eslint/func-names": "off",
    "func-names": "off",

    // Broken autofix: toHaveBeenCalledWith() is stricter than toHaveBeenCalled(); fails
    // when the function receives any arguments (e.g. Iterator from callbacks).
    "vitest/prefer-called-with": "off",

    // Broken autofix: lowercases describe() title strings, changing test semantics.
    "vitest/prefer-lowercase-title": "off",

    // Explicit timeout per test is too prescriptive
    "vitest/require-test-timeout": "off",
    "vitest/require-mock-type-parameters": "off",

    // describe() title format preference
    "vitest/prefer-describe-function-title": "off",

    // toBeFalsy/toBeTruthy are perfectly clear; forcing toBeNull/toBeDefined everywhere is noise
    "vitest/prefer-strict-boolean-matchers": "off",

    // new Promise() is sometimes necessary (e.g. wrapping callbacks)
    "promise/avoid-new": "off",

    // Promise param naming is a convention, not a correctness issue
    "promise/param-names": "off",

    // Callbacks and .then() chains are legitimate in DOM and async event code
    "promise/prefer-await-to-then": "off",
    "promise/prefer-await-to-callbacks": "off",
    // Side-effect-only .then() handlers don't need an explicit return value
    "promise/always-return": "off",

    // i++ is idiomatic in for loops
    "no-plusplus": "off",

    // continue is fine in loops
    "no-continue": "off",

    // Style preference; negated conditions can be clearer
    "no-negated-condition": "off",
    "eslint/no-negated-condition": "off",

    // Project returns null as a sentinel value (e.g. merge3 on conflict)
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

    // Non-null assertions are an intentional pattern for post-bounds-checked array indexing
    "typescript/no-non-null-assertion": "off",

    // Class methods that don't reference this are legitimate (e.g. event handlers, stubs)
    "class-methods-use-this": "off",

    // Async functions without await appear in interface implementations
    "require-await": "off",

    // void used for fire-and-forget async calls
    "no-void": "off",

    // TypeScript handles scope and function hoisting; fires on valid TS hoisting patterns
    "no-use-before-define": "off",

    // Early return in Promise executor is standard control-flow
    "no-promise-executor-return": "off",

    // Browser code uses window legitimately; globalThis is technically equivalent but not idiomatic
    "unicorn/prefer-global-this": "off",

    // Async IIFEs serve different purposes than top-level await (e.g. fire-and-forget initialization)
    "unicorn/prefer-top-level-await": "off",

    // search-cli.ts is a Node CLI; process.exit() is correct there
    "unicorn/no-process-exit": "off",

    // Adding return types to every internal function is high noise for low benefit
    "typescript/explicit-function-return-type": "off",
    "typescript/explicit-module-boundary-types": "off",

    // console.warn/error used for offline/error diagnostics; no structured logger exists
    "no-console": "off",

    // Bitwise operators are intentional (e.g. >>> for unsigned right shift in binary search)
    "no-bitwise": "off",

    // confirm() is an intentional UI pattern; will revisit if custom dialogs are added
    "no-alert": "off",

    // Inner functions often improve readability by keeping related code together
    "unicorn/consistent-function-scoping": "off",

    // .map(fn) is idiomatic and safe; forcing .map(x => fn(x)) everywhere is noise
    "unicorn/no-array-callback-reference": "off",

    // Prefer direct property access over destructuring for simple event handlers
    "eslint/prefer-destructuring": "off",
    "prefer-destructuring": "off",

    // prefer type over interface
    "consistent-type-definitions": "off",

    "unicorn/number-literal-case": "off",

    "unicorn/prefer-add-event-listener": "off",
    "unicorn/require-module-specifiers": "off",
    "no-await-in-loop": "off",

    // Disabled: too much agent churn for cosmetic preferences
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

    // Benchmarks legitimately use new Function() for dynamic test generation
    "no-new-func": "off",
    "eslint/no-new-func": "off",

    // False positive: undo/redo loops capture `current` as a fixed reference and
    // advance `entry` + `undoIndex` instead. `current` isn't meant to change.
    "eslint/no-unmodified-loop-condition": "off",
    "no-unmodified-loop-condition": "off",

    "numeric-separators-style": "off",
  },
  overrides: [
    {
      // no-empty-function: noop callbacks like applyIndent: () => {} are intentional in tests
      files: ["**/*.test.ts", "**/e2e/**/*.ts", "**/test-helper.ts", "**/search-cli.ts"],
      rules: {
        "no-empty-function": "off",
      },
    },
    {
      files: ["**/e2e/**/*.ts"],
      rules: {
        // Browser-context scripts passed to page.addInitScript use (window as any) casts
        "typescript/no-explicit-any": "off",
        // Mock constructors track `this` via closure to simulate server-drop behavior
        "typescript/no-this-alias": "off",
        "unicorn/no-this-assignment": "off",
        // srv.close callback only resolves once (rej/res are mutually exclusive)
        "promise/no-multiple-resolved": "off",
        // Inline class expressions inside addInitScript count as multiple classes
        "max-classes-per-file": "off",
        // mulberry32 PRNG intentionally mutates its closure parameter as state
        "no-param-reassign": "off",
        // | 0 is ToInt32 (signed 32-bit wrap), not truncation — Math.trunc would be wrong
        "unicorn/prefer-math-trunc": "off",
      },
    },
    {
      // vitest/vite config files must use default export — that's how the tool discovers them
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
      // SolidJS ref pattern: `let el!: T` is assigned at mount via ref={el}; oxlint can't see it
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
