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
        CHART_EXTRACT_QUEUE_URL: props.chartExtractQueue.queueUrl,
        JOTFORM_INGEST_QUEUE_URL: props.jotformIngestQueue.queueUrl,
        // Shared secret in the Jotform webhook URL path. Populated out-of-band via CLI; injected as
        // a deploy-time dynamic ref (same pattern as the worker token). Enables the webhook to accept.
        JOTFORM_WEBHOOK_SECRET: secretsmanager.Secret.fromSecretNameV2(this, 'JotformWebhookSecret', `compact-emr-${props.config.envName}/jotform-webhook-secret`).secretValue.unsafeUnwrap(),
        // Chart auto-extract: 'on' makes the merge endpoint WRITE extracted rows into the chart
        // (non-destructive). Controlled by cdk.json context `chart_autofill` (default off = shadow).
        // The draft-readiness DOOR (DRAFT_READINESS_GATE) stays separate + off until the popup ships.
        CHART_AUTOFILL: (this.node.tryGetContext('chart_autofill') as string | undefined) ?? 'off',
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
        // Letter editor: surgical-AI key (runtime-fetched from this ARN) + render Lambda name
        // (only set once the render image exists, so the mount wires the invoker only then).
        API_ANTHROPIC_KEY_SECRET_ARN: apiAnthropicSecret.secretArn,
        ...(renderImageTag ? { RENDER_LAMBDA_NAME: renderFnName } : {}),
      },
      bundling: {
        externalModules: ['@prisma/client', '@prisma/engines'],
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
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.PATCH, apigwv2.CorsHttpMethod.DELETE, apigwv2.CorsHttpMethod.OPTIONS],
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
  }
}
