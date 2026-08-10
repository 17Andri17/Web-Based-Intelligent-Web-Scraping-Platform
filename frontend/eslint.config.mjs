import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

/* Lint config with one job: catch the class of bug `vite build` silently
   compiles — a hook called conditionally, or after an early return. That
   changes the hook count between renders and React responds by throwing
   "Rendered more hooks than during the previous render", which unmounts the
   whole app (including main.jsx's stream ResizeObserver).

   Deliberately narrow. `react-hooks/exhaustive-deps` is off: this codebase has
   many intentionally-partial dependency arrays, and turning it on would bury
   the rule that actually matters in warnings. Widen later if you want, but
   keep rules-of-hooks at "error".

   Run: npm run lint  (from frontend/) */
export default [
  { ignores: ["dist/**", "node_modules/**"] },

  {
    // exhaustive-deps is off, so the existing `eslint-disable-next-line
    // react-hooks/exhaustive-deps` comments have nothing to suppress. They are
    // not stale — they document intent and go live again if the rule is ever
    // turned on — so don't report them as unused.
    linterOptions: { reportUnusedDisableDirectives: false },
  },

  {
    files: ["src/**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...globals.es2021 },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      // The whole point of this config.
      "react-hooks/rules-of-hooks": "error",
      // Off on purpose — see the note above.
      "react-hooks/exhaustive-deps": "off",
    },
  },
];
