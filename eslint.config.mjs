import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",

      /**
       * ★ stdout 은 JSON-RPC 채널이다 (CLAUDE.md 불변식 4).
       *   console.log 하나가 프로토콜을 깨뜨린다.
       */
      "no-console": ["error", { allow: ["error", "warn"] }],
    },
  },

  {
    files: ["**/*.test.ts"],
    rules: { "no-console": "off" },
  },
);
