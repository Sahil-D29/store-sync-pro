/** @type {import('@types/eslint').Linter.BaseConfig} */
module.exports = {
  root: true,
  extends: [
    "@remix-run/eslint-config",
    "@remix-run/eslint-config/node",
    "@remix-run/eslint-config/jest-testing-library",
    "prettier",
  ],
  globals: {
    shopify: "readonly"
  },
  overrides: [
    {
      // These integration checks use node:test, not Jest.
      files: ["scripts/catalog-*.test.ts"],
      rules: {
        "jest/no-deprecated-functions": "off",
        "jest/expect-expect": "off",
      },
    },
  ],
};
