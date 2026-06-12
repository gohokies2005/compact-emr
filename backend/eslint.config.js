import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(js.configs.recommended, ...tseslint.configs.recommended, {
  // src/advisory/vendor + src/vendor are MACHINE-VENDORED verbatim from the FRN repo
  // (scripts/vendor-advisory-prompt.cjs) — CommonJS with Node globals, never hand-edited here,
  // so they are not lint targets. scripts/ are plain Node CJS utilities outside the TS project.
  ignores: ['dist', 'src/advisory/vendor', 'src/vendor', 'scripts'],
}, {
  rules: {
    // Allow intentionally-unused params/vars prefixed with _ (e.g. Express error-handler _next),
    // and rest-sibling destructure discards (e.g. `const { version: _v, ...rest } = data`).
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
    // Permit a documented file-level @ts-nocheck (used by the skipped, mock-heavy cases route test).
    '@typescript-eslint/ban-ts-comment': ['error', { 'ts-nocheck': 'allow-with-description', minimumDescriptionLength: 6 }],
  },
});
