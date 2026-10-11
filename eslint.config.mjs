import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import html from 'eslint-plugin-html';
import globals from 'globals';

const rules = {
  ...js.configs.recommended.rules,
  'one-var': ['error', 'never'],
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
};

export default [
  {
    ignores: ['node_modules/**', 'coverage/**', 'dist/**', '.install.lock/**'],
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node },
    rules,
  },
  {
    files: ['ui/**/*.html'],
    plugins: { html },
    languageOptions: { ecmaVersion: 'latest', sourceType: 'script', globals: globals.browser },
    rules,
  },
  prettier,
  { rules: { curly: ['error', 'all'] } },
];
