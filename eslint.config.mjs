// Lint: correctness rules from eslint + typescript-eslint recommended. `any` is allowed at the JSON/wire boundaries
// (SVD XML, provider streams, MCP messages), where it is the honest type; everything else is strict.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'site/**', 'hdrs/**', 'examples/**/include/**', '**/.aletheon/**', 'supabase/functions/**/vendor/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['**/*.mjs', 'scripts/**'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly' } },
  },
);
