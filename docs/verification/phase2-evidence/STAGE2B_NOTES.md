# Stage 2B notes

Stage 2B completes the non-UI delivery items requested for Phase 2:

- Added CloudFormation outputs in `infra/lib/frontend-stack.ts`:
  - `FrontendBucketName`
  - `DistributionId`
- Extended `.github/workflows/deploy-staging.yml` to:
  - build the frontend workspace with Vite
  - read frontend stack outputs via CloudFormation
  - sync `frontend/dist/` to the frontend S3 bucket
  - invalidate the CloudFront distribution
- Extended `.github/workflows/ci.yml` with frontend lint, typecheck, and test steps.
- Added `frontend/README.md` with environment variable and deploy notes.
- Added `docs/PHASE2_VERIFICATION.md` with manual sign-in/RBAC test steps.

Sandbox limitation: this package was prepared without live AWS credentials or dependency installation, so workflow deployment and full `npm ci` validation must be run in GitHub Actions or a developer workstation.
