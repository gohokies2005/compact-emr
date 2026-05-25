import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(js.configs.recommended, ...tseslint.configs.recommended, {
  ignores: ['dist'],
}, {
  rules: {
    // Allow intentionally-unused params/vars prefixed with _ (e.g. Express error-handler _next),
    // and rest-sibling destructure discards (e.g. `const { version: _v, ...rest } = data`).
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
    // Permit a documented file-level @ts-nocheck (used by the skipped, mock-heavy cases route test).
    '@typescript-eslint/ban-ts-comment': ['error', { 'ts-nocheck': 'allow-with-description', minimumDescriptionLength: 6 }],
  },
});
