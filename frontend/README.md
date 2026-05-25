# Compact EMR frontend

Phase 2 provides the React/Vite shell, Cognito custom sign-in flow, role-gated routing, shared UI primitives, and mocked API client. Feature screens remain placeholders until later phases.

## Local setup

```bash
cp frontend/.env.example frontend/.env
npm install
npm run dev -w frontend
```

Required environment variables:

- `VITE_AWS_REGION`
- `VITE_COGNITO_USER_POOL_ID`
- `VITE_COGNITO_CLIENT_ID`
- `VITE_API_BASE_URL`
- `VITE_USE_MOCK_API=true`

For staging, add those same `VITE_*` values as GitHub Environment secrets/variables for the `staging` environment before deploying.

## Commands

```bash
npm run lint -w frontend
npm run typecheck -w frontend
npm run test -w frontend
npm run build -w frontend
```

## HIPAA frontend convention

Do not log PHI to the browser console. Components that eventually render veteran data should handle errors through typed UI states and non-PHI request IDs only.

## Deploy notes

The staging workflow builds `frontend/dist`, syncs it to the CloudFront-backed S3 bucket, and invalidates CloudFront. Bucket name and distribution ID are read from the `FrontendBucketName` and `DistributionId` CloudFormation outputs.
