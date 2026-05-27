import tseslint from "typescript-eslint";

// Privacy by underscore-prefix convention.
//
// A file or folder whose name starts with `_` is private to its containing
// directory: only same-folder siblings may import it. Any cross-folder
// reach into a `_`-prefixed name is banned.
//
// Examples (from `src/pkg/auth/login.ts`):
//   import { x } from "./_helper.js"          ✓ same-folder _file
//   import { x } from "./_helpers/util.js"    ✓ own _subfolder
//   import { x } from "./session.js"          ✓ public sibling
//   import { x } from "../manifest/_cache.js" ✗ sibling's private file
//   import { x } from "../manifest/cache.js"  ✓ sibling's public file

export default [
  {
    ignores: ["dist/**", "submod/**", "node_modules/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      // Honor the `_`-prefix-means-intentionally-unused convention for
      // function args (e.g. mock stubs that preserve a signature).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/_*",     // any import whose final segment starts with _
                "**/_*/**",  // any import passing through a _-prefixed folder
                "!./_*",     // same-folder _file imports allowed
                "!./_*/**",  // own _-prefixed subfolder contents allowed
              ],
              message:
                "Underscore-prefixed files and folders are private to their containing directory.",
            },
            {
              group: ["../**"],
              message:
                "Use `@/...` for cross-folder imports; only same-folder `./` is allowed.",
            },
          ],
        },
      ],
    },
  },
];
