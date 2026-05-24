const { execSync } = require('node:child_process');

try {
  execSync('git diff --quiet -- backend/prisma/migrations backend/prisma/schema.prisma', { stdio: 'inherit' });
  execSync('git diff --cached --quiet -- backend/prisma/migrations backend/prisma/schema.prisma', { stdio: 'inherit' });
  console.log('Prisma migrations are committed/clean.');
} catch {
  console.error('Prisma schema or migrations changed without being committed. Commit backend/prisma/schema.prisma and backend/prisma/migrations before merging.');
  process.exit(1);
}
