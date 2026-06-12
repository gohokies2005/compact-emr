import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(js.configs.recommended, ...tseslint.configs.recommended, {
  // The top-level scripts/*.js|cjs are plain Node CJS build utilities (bundle-copy,
  // preflight-drafter-gate) — Node globals, outside the TS project, not lint targets.
  // scripts/__tests__/ stays linted (first-party test code).
  ignores: ['dist', 'cdk.out', 'scripts/*.js', 'scripts/*.cjs'],
});
