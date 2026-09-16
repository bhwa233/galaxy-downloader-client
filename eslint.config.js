import js from '@eslint/js'
import ts from 'typescript-eslint'
export default ts.config(
  { ignores: ['dist/**', 'dist-electron/**', 'release/**', 'node_modules/**', '.venv/**', 'engine-build/**', 'resources/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended, ...ts.configs.recommended,
  { files: ['**/*.{ts,tsx}'], rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }] } },
  { files: ['src/components/ui/**'], rules: { '@typescript-eslint/no-empty-object-type': 'off' } },
  { files: ['**/*.{js,mjs}'], languageOptions: { globals: { process: 'readonly', console: 'readonly' } } },
)
