const antfu = require('@antfu/eslint-config').default;

module.exports = antfu(
  {
    typescript: true,
    vue: true,
    stylistic: false,
    ignores: ['node_modules/**', '.nuxt/**', '.output/**', '.sentry-sourcemaps/**', 'dist/**'],
  },
  {
    languageOptions: {
      parserOptions: {
        sourceType: 'module',
      },
    },
    rules: {
      'antfu/top-level-function': 'off',
      'no-unneeded-ternary': 'off',
      'node/prefer-global/process': 'off',
      'perfectionist/sort-imports': 'off',
      'prefer-template': 'off',
      'test/no-import-node-test': 'off',
      'ts/consistent-type-imports': 'off',
      'ts/no-use-before-define': 'off',
      'vue/no-mutating-props': 'off',
    },
  },
  // Prettier validates formatting separately; keep one authority for indentation.
  require('eslint-config-prettier'),
);
