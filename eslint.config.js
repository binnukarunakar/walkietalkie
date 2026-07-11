import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.d.ts", "**/coverage/**"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      eqeqeq: ["error", "always"],
      "no-console": ["error", { allow: ["error"] }],
    },
  },
  {
    files: ["**/*.test.ts", "**/vitest.config.ts", "**/*.config.ts", "**/*.config.js"],
    rules: {
      "@typescript-eslint/explicit-module-boundary-types": "off",
    },
  },
);
