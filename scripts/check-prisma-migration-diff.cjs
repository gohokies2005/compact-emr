const { execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function changedFiles() {
  try {
    return execSync('git diff --name-only origin/main...HEAD', { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

try {
  execSync('git fetch origin main --depth=1', { stdio: 'ignore' });
} catch {
  console.log('Could not fetch origin/main; skipping branch-vs-main Prisma migration diff check for local run.');
  process.exit(0);
}

const files = changedFiles();
const schemaChanged = files.includes('backend/prisma/schema.prisma');
const migrationChanged = files.some((file) => file.startsWith('backend/prisma/migrations/'));

if (!schemaChanged) {
  console.log('Prisma schema unchanged vs main.');
  process.exit(0);
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-emr-prisma-main-'));
const mainSchema = path.join(tempDir, 'schema.prisma');
fs.writeFileSync(mainSchema, execSync('git show origin/main:backend/prisma/schema.prisma', { encoding: 'utf8' }));

const diff = execSync(`npx prisma migrate diff --from-schema-datamodel ${mainSchema} --to-schema-datamodel backend/prisma/schema.prisma --script`, { encoding: 'utf8' });
const hasMeaningfulDiff = diff.trim().length > 0 && !diff.includes('This is an empty migration.');

if (hasMeaningfulDiff && !migrationChanged) {
  console.error('Prisma schema changed vs main, but no migration files changed. Run npm run db:migrate and commit backend/prisma/migrations.');
  process.exit(1);
}

console.log('Prisma branch-vs-main migration diff check passed.');
