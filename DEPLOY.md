# Compact EMR Deployment Guide — Phase 0

This guide assumes a new dedicated AWS account for Compact EMR and the domain `emr.flatratenexus.com`.

## 1. Create the AWS account

1. Create a new AWS account with a dedicated root email.
2. Enable MFA on the root user immediately.
3. Store root credentials in a secure password manager.
4. Add billing contact information.
5. Create a billing alarm in CloudWatch for an early threshold such as `$50`.
6. Do not use the root user for daily work.

## 2. Sign the AWS Business Associate Addendum

Before storing PHI:

1. Open AWS Artifact.
2. Review and accept the AWS Business Associate Addendum.
3. Download/save the executed agreement for compliance records.
4. Confirm planned services are HIPAA-eligible: RDS, S3, Lambda, API Gateway, Cognito, SQS, KMS, CloudWatch, X-Ray, Secrets Manager.

## 3. Create initial IAM admin user

This is used only for first bootstrap.

1. Create an IAM user such as `compact-emr-bootstrap-admin`.
2. Assign temporary administrator access.
3. Create access keys.
4. Configure local AWS CLI:

```bash
aws configure --profile compact-emr-bootstrap
```

Delete these access keys after GitHub OIDC deployment is working.

## 4. CDK bootstrap

Install dependencies:

```bash
npm install
```

Bootstrap the account/region:

```bash
AWS_PROFILE=compact-emr-bootstrap \
  npm run cdk -w infra -- bootstrap aws://ACCOUNT_ID/us-east-1
```

## 5. Route 53 and DNS options

### Option A — Route 53 hosted zone delegated from Cloudflare

1. Create or import the `flatratenexus.com` hosted zone in Route 53.
2. Copy the Route 53 nameservers.
3. In Cloudflare, delegate the relevant records or subdomain.
4. Put the hosted zone ID into `infra/cdk.json` under `hostedZoneId`.

### Option B — Cloudflare-managed DNS

CloudFront aliases and ACM DNS validation can still work, but this scaffold currently expects Route 53 for automatic DNS validation and A-record creation. If keeping DNS entirely in Cloudflare, replace the `FrontendStack` certificate and DNS automation with manual ACM validation records and manual CNAME/Alias configuration.

## 6. Configure GitHub OIDC deploy role

Create an IAM role trusted by GitHub Actions.

Trust policy example:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:OWNER/REPO:*"
        }
      }
    }
  ]
}
```

For Phase 0, attach a broad CDK deploy policy while bootstrapping. Before production launch, narrow this policy to the resources and actions required by the CDK app.

Add the role ARN as a GitHub Environment secret:

- `staging` environment: `AWS_DEPLOY_ROLE_ARN`
- `prod` environment: `AWS_DEPLOY_ROLE_ARN`

## 7. GitHub Environment reviewer protection — required before any deploy

Before running either deploy workflow, configure GitHub Environments so no one can deploy by casually pressing a button:

1. In GitHub, open **Settings → Environments**.
2. Create or edit the `staging` environment.
3. Add at least one required reviewer before deployment is allowed.
4. Add the `AWS_DEPLOY_ROLE_ARN` secret for staging.
5. Repeat the same steps for the `prod` environment.
6. Add at least one required reviewer for prod. Prefer a different reviewer than the person clicking deploy.
7. Confirm both `deploy-staging.yml` and `deploy-prod.yml` target the correct environment names.

The workflows also include concurrency controls:

- `deploy-staging`: only one staging deploy can run at a time.
- `deploy-prod`: only one prod deploy can run at a time.

## 8. First synth

```bash
npm run cdk:synth:staging
```

## 9. First staging deploy

Use the GitHub Actions `Deploy staging` workflow after the staging Environment reviewer approves it, or run locally only during initial bootstrap:

```bash
npm run cdk -w infra -- deploy --all --context env=staging
```

## 10. First prod deploy

Use the manual GitHub Actions workflow `Deploy prod` after the prod Environment reviewer approves it. Local prod deploys should be reserved for break-glass infrastructure recovery only:

```bash
npm run cdk -w infra -- deploy --all --context env=prod
```

## 11. Emergency MFA reset — HIPAA §164.308(a)(7) break-glass procedure

Cognito requires TOTP MFA. If an admin loses a device, use the break-glass Lambda to clear that user's MFA preference so they can re-enroll TOTP on next login.

Required controls:

1. Confirm identity out-of-band before invoking the reset.
2. Log the ticket/reason in the compliance log.
3. Have a second admin approve the reset whenever possible.
4. Invoke only for the named user.
5. After the user logs in, require immediate TOTP re-enrollment.
6. Record completion in the compliance log.

CLI example:

```bash
aws lambda invoke \
  --function-name compact-emr-staging-auth-BreakGlassMfaResetFunctionXXXXXXXX-XXXXXXXX \
  --payload '{"username":"admin@example.com"}' \
  --cli-binary-format raw-in-base64-out \
  /tmp/mfa-reset-result.json
cat /tmp/mfa-reset-result.json
```

The Lambda role is scoped to `cognito-idp:AdminSetUserMFAPreference` on this app's Cognito user pool only.

## 12. Encryption verification checklist

After deploy, verify:

- RDS storage encryption is enabled with KMS.
- RDS exports PostgreSQL logs to CloudWatch.
- S3 PHI bucket uses KMS encryption and blocks public access.
- S3 PHI bucket has `RETAIN` removal policy and is not auto-deleted by stack destroy.
- S3 frontend bucket blocks public access and is reachable only through CloudFront.
- SQS queues enforce SSL.
- API Gateway uses TLS.
- CloudFront uses ACM cert for `emr.flatratenexus.com`.
- CloudFront has the AWS-managed security headers response policy attached.
- Lambda environment variables do not contain PHI or plaintext secrets.
- Lambda has X-Ray tracing active and CloudWatch log retention set to six months.
- CloudWatch logs do not contain PHI.

## 13. Remove bootstrap credentials

After GitHub OIDC deploy succeeds:

1. Delete the bootstrap IAM user's access keys.
2. Remove administrator access from the bootstrap user or delete the user.
3. Keep break-glass access documented separately.

## 14. Architect findings addressed in this revision

1. **DB security-group ingress:** `ApiStack` now accepts `database: rds.IDatabaseInstance` and calls `props.database.connections.allowDefaultPortFrom(fnSg, 'Compact EMR API Lambda → Postgres')`.
2. **Documents bucket KMS grants:** `StorageStack` exposes `documentsKey`; `ApiStack` calls `props.documentsKey.grantEncryptDecrypt(handler)` in addition to `phiBucket.grantReadWrite(handler)`.
3. **PHI bucket deletion risk:** PHI S3 bucket now unconditionally uses `RemovalPolicy.RETAIN`; `autoDeleteObjects` was removed; source comment documents that PHI buckets are never auto-deleted by stack destroy.
4. **Deploy concurrency and approval:** staging and prod workflows now include deployment concurrency groups, and this guide requires reviewer protection on both GitHub Environments before deploy.
5. **MFA lockout:** `AuthStack` now includes a break-glass MFA reset Lambda with IAM scoped to `cognito-idp:AdminSetUserMFAPreference` for this user pool.
6. **Lambda log retention:** API Lambda log retention is set to six months.
7. **Lambda X-Ray tracing:** API Lambda tracing is set to active.
8. **CloudFront security headers:** `FrontendStack` attaches `cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS` to the default behavior.
9. **Lambda timeout:** API Lambda timeout is now 29 seconds, leaving 1 second below the HTTP API 30-second cap.
10. **Localhost CORS:** localhost `http://localhost:5173` is allowed only when `envName !== 'prod'`.
11. **Lambda entry path:** API Lambda now uses `path.resolve(__dirname, '../../backend/src/placeholder-lambda.ts')`.
12. **RDS PostgreSQL logs:** RDS now exports `postgresql` logs to CloudWatch.
13. **Phase 1 TODOs documented:** VPC endpoints and WAF are listed below.

## 15. Phase 1 TODOs — do not implement in Phase 0

- Add VPC interface endpoints for Secrets Manager, SQS, and KMS.
- Add an S3 gateway endpoint.
- Add AWS WAF v2 to CloudFront and API Gateway.
- Use AWS managed rule group `AWSManagedRulesCommonRuleSet`.
- Add a rate-limit rule suitable for the expected staff-only traffic pattern.
- Replace broad bootstrap-time CDK deploy permissions with least-privilege deployment permissions.

## Phase 1 migration deployment

Phase 1 adds Prisma migrations under `backend/prisma/migrations`. Local development uses:

```bash
DATABASE_URL=postgresql://compact_emr:compact_emr_dev_password@localhost:5432/compact_emr npm run db:migrate
```

AWS deployment provisions a `compact-emr-<env>-prisma-migrate-deploy` CodeBuild project in the API stack. The project runs `npm run db:migrate:deploy` in the VPC with access to the RDS secret. The deploy role must be allowed to start that CodeBuild project after `cdk deploy` completes.

For v1 operations, run the migration project after each staging/prod deploy that includes new migrations:

```bash
aws codebuild start-build --project-name compact-emr-staging-prisma-migrate-deploy --region us-east-1
aws codebuild batch-get-builds --ids <build-id> --region us-east-1
```

CI runs two migration checks:

1. `npm run migrate:check` — fails if Prisma schema/migration files are dirty in the PR checkout.
2. `npm run migrate:diff-check` — compares `backend/prisma/schema.prisma` against `origin/main`; if the schema changed without a migration file change, the PR fails.

## Phase 1 auth environment

The API Lambda receives:

- `DATABASE_URL` — CloudFormation dynamic reference assembled from the RDS Secrets Manager secret.
- `DATABASE_URL_SECRET_ARN` — fallback/runtime construction path for tools that should read the secret directly.
- `COGNITO_ISSUER` and `COGNITO_CLIENT_ID` should be added before production route expansion so middleware can verify tokens against Cognito JWKS.

## Phase 1 verification evidence

See `docs/verification/phase1-evidence/` for local migration/test/curl evidence captured for this revision.
