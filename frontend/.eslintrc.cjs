module.exports = {
  root: true,
  env: { browser: true, es2022: true, node: true },
  extends: ['eslint:recommended'],
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint', 'react-hooks', 'react-refresh'],
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module', project: './tsconfig.json' },
  ignorePatterns: ['dist', 'coverage'],
  overrides: [
    {
      // Build config files live at the package root and are not part of tsconfig's
      // project, so the type-aware parser cannot resolve them. Lint them without `project`.
      files: ['*.config.js', '*.config.cjs'],
      parserOptions: { project: null }
    }
  ],
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'react-refresh/only-export-components': ['warn', { allowConstantExport: true }]
  }
};
