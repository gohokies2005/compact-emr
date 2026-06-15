import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  aws_apigatewayv2 as apigwv2,
  aws_apigatewayv2_authorizers as authorizers,
  aws_apigatewayv2_integrations as integrations,
  aws_cognito as cognito,
  aws_ec2 as ec2,
  aws_kms as kms,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  aws_logs as logs,
  aws_rds as rds,
  aws_s3 as s3,
  aws_secretsmanager as secretsmanager,
  aws_codebuild as codebuild,
  aws_iam as iam,
  aws_sqs as sqs,
  aws_ecr as ecr,
} from 'aws-cdk-lib';
import type { CompactEmrConfig } from './config.js';
import { DRAFTER_MAX_CONCURRENCY } from './drafter-constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ApiStackProps extends StackProps {
  config: CompactEmrConfig;
  vpc: ec2.IVpc;
  database: rds.IDatabaseInstance;
  databaseSecurityGroup: ec2.ISecurityGroup;
  databaseSecret: secretsmanager.ISecret;
  userPool: cognito.IUserPool;
  userPoolClient: cognito.IUserPoolClient;
  draftQueue: sqs.IQueue;
  phiBucket: s3.IBucket;
  doctorPacksBucket: s3.IBucket;
  documentsKey: kms.IKey;
  doctorPackQueue: sqs.IQueue;
  workerTokenSecret: secretsmanager.ISecret;
  draftJobQueue: sqs.IQueue;
  drafterInvokeTokenSecret: secretsmanager.ISecret;
  chartExtractQueue: sqs.IQueue;
  jotformIngestQueue: sqs.IQueue;
}

export class ApiStack extends Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const fnSg = new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
      vpc: props.vpc,
      allowAllOutbound: true,
      description: 'Compact EMR API Lambda egress and DB access group.',
    });
    new ec2.CfnSecurityGroupIngress(this, 'DatabaseIngressFromApiLambda', {
      groupId: props.databaseSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      sourceSecurityGroupId: fnSg.securityGroupId,
      description: 'Compact EMR API Lambda to Postgres',
    });

    const apiLogGroup = new logs.LogGroup(this, 'ApiLambdaLogGroup', {
      logGroupName: `/aws/lambda/compact-emr-${props.config.envName}-api`,
      retention: logs.RetentionDays.SIX_MONTHS,
      removalPolicy: props.config.envName === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    const databaseUrl = cdk.Fn.sub(
      'postgresql://{{resolve:secretsmanager:${secretArn}:SecretString:username}}:{{resolve:secretsmanager:${secretArn}:SecretString:password}}@${host}:${port}/compact_emr?schema=public',
      {
        secretArn: props.databaseSecret.secretArn,
        host: props.database.dbInstanceEndpointAddress,
        port: props.database.dbInstanceEndpointPort,
      },
    );

    // ── Letter editor: render Lambda repo + surgical-AI secret ──────────────────────────
    // The render Lambda image is built + pushed by the deploy window (drafter-style); the ECR
    // repo exists from first deploy so they have somewhere to push. The Lambda itself is only
    // created once `render_image_tag` is set (a DockerImageFunction needs its image to exist at
    // deploy — so the first deploy is clean and render-less until the image is pushed).
    const renderRepo = new ecr.Repository(this, 'LetterRenderRepo', {
      repositoryName: `compact-emr-${props.config.envName}-render`,
      removalPolicy: props.config.envName === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    const renderImageTag = this.node.tryGetContext('render_image_tag') as string | undefined;
    const renderFnName = `compact-emr-${props.config.envName}-letter-render`;
    // Anthropic key for surgical-AI (Opus 4.8). Operator fills it post-deploy (like the drafter
    // key); the API reads it at RUNTIME from this ARN, so filling needs no redeploy.
    const apiAnthropicSecret = new secretsmanager.Secret(this, 'ApiAnthropicKey', {
      secretName: `compact-emr-${props.config.envName}/api-anthropic-api-key`,
    });

    // Stripe webhook SIGNING secret (whsec_) — operator-populated AFTER deploy (you add the webhook
    // endpoint in the Stripe dashboard Webhooks section, Stripe hands you the secret, you paste it
    // here). Read at runtime by FRIENDLY NAME (never partial ARN — the AccessDenied footgun). This is
    // the ONLY Stripe secret the core payment→delivery chain needs (no sk_ key — a signature-verified
    // event is trusted; the sk_/restricted key is only for the future poller).
    const stripeWebhookSecret = new secretsmanager.Secret(this, 'StripeWebhookSecret', {
      secretName: `compact-emr-${props.config.envName}/stripe-webhook-secret`,
    });

    // Gmail OAuth grant for the outbound-email transport (EMAIL_TRANSPORT=gmail — SES production
    // access denied 2026-06-11, case 178094063100860; Gmail is BAA-covered under Google Workspace).
    // Operator-populated AFTER deploy (same lifecycle as the Anthropic/Stripe secrets — CDK never
    // owns the value, so it persists across deploys). JSON value shape:
    //   {"client_id":"…","client_secret":"…","refresh_token":"…","user":"info@flatratenexus.com"}
    // Read at RUNTIME by friendly name (mailer.readSecretByName) — never env-injected (audit INF-2).
    const gmailOauthSecret = new secretsmanager.Secret(this, 'GmailOauthSecret', {
      secretName: `compact-emr-${props.config.envName}/gmail-oauth`,
    });

    const handler = new nodejs.NodejsFunction(this, 'PlaceholderApiLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.resolve(__dirname, '../../backend/src/placeholder-lambda.ts'),
      handler: 'handler',
      timeout: Duration.seconds(29), // HttpApi caps at 30s; leave 1s headroom.
      memorySize: 512,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [fnSg],
      logGroup: apiLogGroup,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        ENV_NAME: props.config.envName,
        PHI_BUCKET_NAME: props.phiBucket.bucketName,
        DOCTOR_PACKS_BUCKET_NAME: props.doctorPacksBucket.bucketName,
        DRAFT_QUEUE_URL: props.draftQueue.queueUrl,
        DOCTOR_PACK_QUEUE_URL: props.doctorPackQueue.queueUrl,
        DRAFT_JOB_QUEUE_URL: props.draftJobQueue.queueUrl,
        // Drafter concurrency cap, mirrored from the SAME const that sets the Fargate autoscaler
        // maxCapacity in drafter-stack.ts. The draft-concurrency endpoint reads this to tell a
        // queued draft whether the drafter is genuinely full (running === max). Single source ⇒ the
        // UI threshold can never drift from the real ceiling. Backend falls back to 6 if unset.
        DRAFTER_MAX_CONCURRENCY: String(DRAFTER_MAX_CONCURRENCY),
        CHART_EXTRACT_QUEUE_URL: props.chartExtractQueue.queueUrl,
        JOTFORM_INGEST_QUEUE_URL: props.jotformIngestQueue.queueUrl,
        // Shared secret in the Jotform webhook URL path (enables the webhook to accept). Populated
        // out-of-band via CLI. Use a RAW friendly-name CFN dynamic reference — fromSecretNameV2 emits
        // a partial-ARN form that CloudFormation failed to resolve ("ResourceNotFound") for this
        // secret on deploy; the friendly-name form resolves reliably + is env-portable. (2026-06-04.)
        JOTFORM_WEBHOOK_SECRET: `{{resolve:secretsmanager:compact-emr-${props.config.envName}/jotform-webhook-secret:SecretString}}`,
        // Chart auto-extract: 'on' makes the merge endpoint WRITE extracted rows into the chart
        // (non-destructive: planMerge protects manual + prior-extracted rows; the keystone pkg-6
        // dedup guard in normalizeName collapses the PTSD-variant explosion). DEFAULT IS NOW 'on'
        // (keystone pkg 6 flip, Ryan-authorized conditioned on the guard). KILL SWITCH: cdk.json
        // context `chart_autofill: "off"` or `cdk deploy --context chart_autofill=off` → back to
        // shadow mode (extract + record, zero chart writes). DEPLOY IMPLICATION: this env rides the
        // API task def — the flip takes effect on the next API-stack deploy, after which EVERY
        // completing extraction writes rows into live charts (staging first, eyeball a real case's
        // resultJson, then prod).
        // The draft-readiness DOOR (DRAFT_READINESS_GATE) stays separate + off until the popup ships.
        CHART_AUTOFILL: (this.node.tryGetContext('chart_autofill') as string | undefined) ?? 'on',
        // P4 anchor-viability surface (caseViability v1) — bundle stamp + RN CaseViabilityCard.
        // LIVE 2026-06-14 (Ryan): default graduated 'false'→'true' so the RN-facing viability panel
        // is durably ON (a --context flip would silently revert on the next `cdk deploy --all`). The
        // panel is READ-ONLY advisory; revert = set default back to 'false' (or context override) +
        // deploy (the backend reads it at request time; no image rebuild).
        EMR_CASE_VIABILITY_ENABLED: (this.node.tryGetContext('case_viability_enabled') as string | undefined) ?? 'true',
        // DIRECT-SC viability axis (2026-06-14): folds the direct (in-service-event) axis into the
        // caseViability resolve+rank, emitting caseViability v2 (two-table provenance). ORTHOGONAL to
        // EMR_CASE_VIABILITY_ENABLED (which gates the whole stamp). When off, deriveCaseViability is
        // byte-identical v1. LIVE 2026-06-14 (Ryan, eyeball): default graduated 'false'→'true' on the
        // API ONLY — the panel's direct read is DETERMINISTIC (eventCanon over Case intake fields), no
        // LLM, no per-case cost. The chart-extract event CLASSIFIER (workers-stack) reads the SAME flag
        // but stays 'false' there (it's log-only / not yet fed into viability — no point paying for it).
        // Revert = default→'false' + deploy (read at request time; no image rebuild).
        // TEMPORARILY 'false' 2026-06-15 (Ryan, Pichette): the direct fold manufactured a TERA->OSA
        // "directly supports" read + a FALSE burn-pit presumptive redirect (OSA isn't a burn-pit
        // presumptive — only the condition-keyed _PRESUMPTIVE map is authoritative). Back on after the
        // one-brain fix (exposure events abstain; presumptive gated on the condition, not the exposure class).
        DIRECT_SC_VIABILITY_ENABLED: (this.node.tryGetContext('direct_sc_viability_enabled') as string | undefined) ?? 'false',
        // Doctor-pack grounded source pages (PR-1..PR-4, 2026-06-13): map every extracted chart fact
        // back to the EXACT source page that grounded it and pull those pages into the physician pack
        // (the rating-grant page, the sleep-study AHI, the med list) — protected in the page budget
        // (policy-b: capped-but-protected, lowest-yield-fact trimmed last) + cover why-lines, and the
        // Opus LLM page-picker is narrowed off bulk/Blue-Button docs (the $0 back-map owns them). Default
        // 'on' (Ryan-authorized flip). KILL SWITCH: cdk.json context `doctor_pack_grounded_pages: "off"`
        // → byte-identical to the pre-feature pack. Read at request time in doctor-pack-generate (no image
        // rebuild). LIVE SMOKE owed: regenerate a Blue-Button case's pack + confirm the grant/AHI/med pages
        // + cover why-lines appear; physician review is the backstop, revert is one context flip.
        DOCTOR_PACK_GROUNDED_PAGES: (this.node.tryGetContext('doctor_pack_grounded_pages') as string | undefined) ?? 'on',
        // Guided Revision (physician highlight-the-passage broader letter edit, Opus 4.8) — ON (Ryan
        // 2026-06-14: "guided revision looks good, but not available"). Context-overridable to disable.
        GUIDED_REVISION_ENABLED: (this.node.tryGetContext('guided_revision_enabled') as string | undefined) ?? 'true',
        // Phase 7B: literal worker token from Secrets Manager. unsafeUnwrap embeds the
        // secret value in the Lambda env at deploy time (visible to iam:GetFunction holders).
        // Acceptable for now; future hardening is to switch to runtime SecretsManager.GetSecretValue
        // in the API + workers code.
        INTERNAL_WORKER_TOKEN: props.workerTokenSecret.secretValue.unsafeUnwrap(),
        // Drafter integration: separate higher-privilege token. Token check happens inside
        // the API process via requireDrafterPrincipal middleware on /internal/drafter/* routes.
        DRAFTER_INVOKE_TOKEN: props.drafterInvokeTokenSecret.secretValue.unsafeUnwrap(),
        COGNITO_ISSUER: `https://cognito-idp.${Stack.of(this).region}.amazonaws.com/${props.userPool.userPoolId}`,
        COGNITO_CLIENT_ID: props.userPoolClient.userPoolClientId,
        // Staff provisioning (POST /users) — the API admin-creates Cognito users in this pool.
        COGNITO_USER_POOL_ID: props.userPool.userPoolId,
        DATABASE_URL: databaseUrl,
        DATABASE_URL_SECRET_ARN: props.databaseSecret.secretArn,
        // Ask Aegis ask-path: a DEDICATED read-only connection AS advisory_ro (SELECT-only on
        // advisory.ref_chunk — the architect's #1 landmine: never SET ROLE on a pool). Friendly-name
        // {{resolve}} for the password (NOT a partial ARN — see the JOTFORM note above); host/port via Fn.sub.
        ADVISORY_RO_DATABASE_URL: cdk.Fn.sub(
          `postgresql://advisory_ro:{{resolve:secretsmanager:compact-emr-${props.config.envName}/advisory-ro-db:SecretString:password}}@\${host}:\${port}/compact_emr`,
          { host: props.database.dbInstanceEndpointAddress, port: props.database.dbInstanceEndpointPort },
        ),
        // Letter editor: surgical-AI key (runtime-fetched from this ARN) + render Lambda name
        // (only set once the render image exists, so the mount wires the invoker only then).
        API_ANTHROPIC_KEY_SECRET_ARN: apiAnthropicSecret.secretArn,
        // Stripe payment → password-portal PDF delivery (Ryan 2026-06-06).
        STRIPE_WEBHOOK_SECRET_NAME: `compact-emr-${props.config.envName}/stripe-webhook-secret`,
        STRIPE_LINK_500: 'https://buy.stripe.com/3cI9ALcMG5LH05Y3Xm0Ba03', // public payment link (not a secret)
        STRIPE_LINK_350: 'https://buy.stripe.com/aFa5kvaEygql5qi9hG0Ba01', // $350 letter fee payment link (not a secret)
        SES_FROM_ADDRESS: 'info@flatratenexus.com',                          // From address (verified SES identity AND the Gmail OAuth user)
        // Outbound transport: 'gmail' (default — BAA-covered Workspace send as info@) or anything
        // else for SES (sandbox until the production-access appeal lands). Flip via cdk.json context.
        EMAIL_TRANSPORT: (this.node.tryGetContext('email_transport') as string | undefined) ?? 'gmail',
        GMAIL_OAUTH_SECRET_NAME: `compact-emr-${props.config.envName}/gmail-oauth`,
        DELIVERY_PORTAL_BASE_URL: `https://${props.config.domainName}`,      // /d/<token> lives on the SPA
        DELIVERY_ADMIN_BCC: 'admin@flatratenexus.com',
        // SES-SANDBOX forwarding mode (Ryan 2026-06-10): all veteran emails delivered to this inbox
        // instead, [FWD to <real>] prefixed, staff forwards manually within a few hours. Clear the
        // cdk.json value + deploy to disable once SES production access (case 178094063100860) lands.
        EMAIL_REDIRECT_ALL_TO: (this.node.tryGetContext('email_redirect_all_to') as string | undefined) ?? '',
        ...(renderImageTag ? { RENDER_LAMBDA_NAME: renderFnName } : {}),
      },
      bundling: {
        externalModules: ['@prisma/client', '@prisma/engines', 'pg-native'], // pg-native is pg's optional native client; keep it external so esbuild uses the pure-JS path
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => {
            // Cross-platform bundling via Node fs.cpSync. Prior code used POSIX `mkdir -p` +
            // `cp -R` which Windows cmd.exe rejects; the xcopy fallback exhausted memory on
            // the @prisma engine binaries. The helper script handles both platforms.
            // Use plain `node` (from PATH) — cmd.exe /c strips outer quotes so a full path
            // with spaces (e.g. "C:\Program Files\nodejs\node.exe") breaks the command.
            const helper = path.join(__dirname, '..', 'scripts', 'bundle-copy.cjs');
            const q = (s: string) => `"${s}"`;
            return [
              `node ${q(helper)} ${q(inputDir + '/backend/node_modules/@prisma')} ${q(outputDir + '/node_modules/@prisma')}`,
              `node ${q(helper)} ${q(inputDir + '/backend/node_modules/.prisma')} ${q(outputDir + '/node_modules/.prisma')}`,
              `node ${q(helper)} ${q(inputDir + '/backend/prisma')} ${q(outputDir + '/prisma')}`,
              // Advisory (Ask Aegis): the vendored CJS retrieve modules are NOT bundled (they read data
              // files by __dirname-relative path), so copy the whole tree next to the handler. The wrapper
              // loads it at runtime from <task>/advisory-vendor.
              `node ${q(helper)} ${q(inputDir + '/backend/src/advisory/vendor')} ${q(outputDir + '/advisory-vendor')}`,
              // P4 anchor-viability: the vendored CJS resolver + table are NOT bundled (the
              // resolver reads its table by __dirname-relative path) — copy them next to the
              // handler; case-viability.ts loads <task>/anchor-vendor at runtime (advisory pattern).
              // The whole vendor tree is copied, so the DIRECT-SC additions (directSc.cjs +
              // sc_direct_pairs.json) AND eventCanon.cjs (the event floor) ride along automatically —
              // anchorMechanism.cjs lazy-requires ./directSc.cjs and case-viability.ts loads
              // ./eventCanon.cjs from this same dir on the gated direct-SC path.
              `node ${q(helper)} ${q(inputDir + '/backend/src/vendor')} ${q(outputDir + '/anchor-vendor')}`,
            ];
          },
        },
      }
    });

    props.phiBucket.grantReadWrite(handler);
    props.doctorPacksBucket.grantRead(handler);
    props.documentsKey.grantEncryptDecrypt(handler);
    props.databaseSecret.grantRead(handler);
    props.draftQueue.grantSendMessages(handler);
    props.doctorPackQueue.grantSendMessages(handler);
    props.draftJobQueue.grantSendMessages(handler);
    props.chartExtractQueue.grantSendMessages(handler);
    props.jotformIngestQueue.grantSendMessages(handler);

    // ── Letter editor grants ──────────────────────────────────────────────────────────
    // API Lambda reads the surgical-AI key at runtime. (phiBucket RW + documentsKey already
    // granted above cover the letter-revisions/* artifacts.)
    apiAnthropicSecret.grantRead(handler);

    // Ask Aegis: invoke Opus 4.6 (the answer) + Titan-v2 (the query embedding) on Bedrock.
    handler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: ['*'], // InvokeModel-only (read inference); tighten to the model + inference-profile ARNs later
    }));

    // Stripe + delivery: read the webhook signing secret at runtime; send the portal email via SES.
    stripeWebhookSecret.grantRead(handler);
    // Gmail transport: read the OAuth grant at runtime (friendly name; CDK-created so the full ARN
    // grant resolves — not the fromSecretNameV2 partial-ARN footgun).
    gmailOauthSecret.grantRead(handler);
    handler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'], // SES SendEmail is identity-scoped; '*' is the conventional resource for send
    }));

    // Staff provisioning: the API admin-creates/enables/disables Cognito users in THIS pool only
    // (POST /users, PATCH /users/:id). Scoped to the pool ARN — not the account-wide '*'.
    handler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cognito-idp:AdminCreateUser',
        'cognito-idp:AdminGetUser',
        'cognito-idp:AdminAddUserToGroup',
        'cognito-idp:AdminRemoveUserFromGroup',
        'cognito-idp:AdminSetUserPassword',
        'cognito-idp:AdminEnableUser',
        'cognito-idp:AdminDisableUser',
        'cognito-idp:AdminResetUserPassword',
        'cognito-idp:AdminSetUserMFAPreference',
      ],
      resources: [props.userPool.userPoolArn],
    }));

    if (renderImageTag) {
      const renderLambda = new lambda.DockerImageFunction(this, 'LetterRenderLambda', {
        functionName: renderFnName,
        code: lambda.DockerImageCode.fromEcr(renderRepo, { tagOrDigest: renderImageTag }),
        timeout: Duration.seconds(60),
        memorySize: 1024,
        tracing: lambda.Tracing.ACTIVE,
        environment: { ENV_NAME: props.config.envName },
        // No VPC: touches only S3 + KMS, not RDS — avoids the NAT/ENI cold-start tax.
      });
      props.phiBucket.grantReadWrite(renderLambda);        // read the txt + write letter-revisions/*
      props.documentsKey.grantEncryptDecrypt(renderLambda); // phiBucket is KMS-encrypted
      renderLambda.grantInvoke(handler);                    // API Lambda invokes it synchronously
    }


    const migrationProject = new codebuild.Project(this, 'PrismaMigrateDeployProject', {
      projectName: `compact-emr-${props.config.envName}-prisma-migrate-deploy`,
      vpc: props.vpc,
      subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [fnSg],
      source: codebuild.Source.gitHub({
        owner: 'gohokies2005',
        repo: 'compact-emr',
        cloneDepth: 1,
        webhook: true,
        webhookFilters: [
          codebuild.FilterGroup.inEventOf(codebuild.EventAction.PUSH)
            .andBranchIs('main')
            .andFilePathIs('backend/prisma/migrations/.*'),
        ],
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2023_5,
        computeType: codebuild.ComputeType.SMALL,
        privileged: false,
      },
      environmentVariables: {
        DATABASE_URL_SECRET_ARN: { value: props.databaseSecret.secretArn },
        ENV_NAME: { value: props.config.envName },
      },
      buildSpec: codebuild.BuildSpec.fromObjectToYaml({
        version: '0.2',
        phases: {
          install: {
            commands: ['dnf install -y postgresql15 jq'],
          },
          build: {
            commands: [
              'chmod +x scripts/codebuild-prisma-migrate.sh',
              './scripts/codebuild-prisma-migrate.sh',
            ],
          },
        },
      }),
    });
    props.databaseSecret.grantRead(migrationProject);
    migrationProject.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'codeconnections:UseConnection',
        'codeconnections:GetConnection',
        'codeconnections:GetConnectionToken',
        'codestar-connections:UseConnection',
        'codestar-connections:GetConnection',
        'codestar-connections:GetConnectionToken',
      ],
      resources: [
        `arn:aws:codeconnections:${this.region}:${this.account}:connection/*`,
        `arn:aws:codestar-connections:${this.region}:${this.account}:connection/*`,
      ],
    }));
    new ec2.CfnSecurityGroupIngress(this, 'DatabaseIngressFromMigrationCodeBuild', {
      groupId: props.databaseSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      sourceSecurityGroupId: fnSg.securityGroupId,
      description: 'Compact EMR migration CodeBuild to Postgres',
    });

    const allowOrigins = props.config.envName === 'prod'
      ? [`https://${props.config.domainName}`]
      : [`https://${props.config.domainName}`, 'http://localhost:5173'];

    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `compact-emr-${props.config.envName}`,
      corsPreflight: {
        allowHeaders: ['authorization', 'content-type'],
        // PUT is required by the letter-editor "Save new version" (api/letter.ts apiPut → backend
        // router.put /cases/:id/letter). It was missing here AND from the proxy route methods below, so
        // the browser preflight blocked every manual letter save ("Network Error"). (2026-06-06.)
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.PUT, apigwv2.CorsHttpMethod.PATCH, apigwv2.CorsHttpMethod.DELETE, apigwv2.CorsHttpMethod.OPTIONS],
        allowOrigins,
      },
    });

    const authorizer = new authorizers.HttpUserPoolAuthorizer('CognitoAuthorizer', props.userPool, {
      userPoolClients: [props.userPoolClient],
    });

    httpApi.addRoutes({
      path: '/api/v1/health',
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration('HealthIntegration', handler),
      authorizer,
    });

    httpApi.addRoutes({
      path: '/api/v1/{proxy+}',
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.POST,
        apigwv2.HttpMethod.PUT, // letter-editor save (router.put /cases/:id/letter) — was unroutable
        apigwv2.HttpMethod.PATCH,
        apigwv2.HttpMethod.DELETE,
      ],
      integration: new integrations.HttpLambdaIntegration('ApiProxyIntegration', handler),
      authorizer,
    });

    // Worker callbacks (/api/v1/internal/drafter/*) authenticate via X-Drafter-Invoke-Token in the
    // requireDrafterPrincipal middleware, NOT Cognito. They MUST bypass the Cognito JWT authorizer,
    // or the Fargate worker's /progress + /complete posts get a gateway 401. HttpApi matches the
    // more-specific route first, so this takes precedence over /api/v1/{proxy+} for internal paths.
    httpApi.addRoutes({
      path: '/api/v1/internal/{proxy+}',
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.POST,
        apigwv2.HttpMethod.PATCH,
      ],
      integration: new integrations.HttpLambdaIntegration('InternalApiProxyIntegration', handler),
      // no authorizer — token auth enforced in-app by requireDrafterPrincipal
    });

    // Jotform webhook (/api/v1/jotform/webhook/:secret) is PUBLIC + secret-gated IN-APP (the secret
    // path segment is validated in createJotformWebhookRouter). It MUST bypass the Cognito JWT
    // authorizer or Jotform's POST gets a gateway 401 ({"message":"Unauthorized"}). More-specific
    // route wins over /api/v1/{proxy+}. (2026-06-04 — found the webhook 401ing at the gateway.)
    httpApi.addRoutes({
      path: '/api/v1/jotform/webhook/{proxy+}',
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('JotformWebhookIntegration', handler),
      // no authorizer — secret auth enforced in-app
    });

    // Stripe webhook (PUBLIC — Stripe SIGNATURE is the auth, verified in-app) + the password-protected
    // delivery portal (PUBLIC — token + emailed password are the auth). Both bypass the Cognito
    // authorizer; more-specific routes win over /api/v1/{proxy+}. (Ryan 2026-06-06.)
    httpApi.addRoutes({
      path: '/api/v1/stripe/webhook',
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('StripeWebhookIntegration', handler),
      // no authorizer — Stripe signature enforced in-app (verifyStripeSignature)
    });
    httpApi.addRoutes({
      path: '/api/v1/delivery/{proxy+}',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('DeliveryPortalIntegration', handler),
      // no authorizer — token + password enforced in-app
    });
  }
}
