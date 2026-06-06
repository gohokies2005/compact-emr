import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  aws_cloudwatch as cloudwatch,
  aws_ec2 as ec2,
  aws_events as events,
  aws_events_targets as targets,
  aws_iam as iam,
  aws_kms as kms,
  aws_lambda as lambda,
  aws_lambda_event_sources as eventSources,
  aws_lambda_nodejs as nodejs,
  aws_logs as logs,
  aws_rds as rds,
  aws_s3 as s3,
  aws_secretsmanager as secretsmanager,
  aws_sns as sns,
  aws_sns_subscriptions as subs,
  aws_sqs as sqs,
} from 'aws-cdk-lib';
import type { CompactEmrConfig } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface WorkersStackProps extends StackProps {
  config: CompactEmrConfig;
  phiBucket: s3.IBucket;
  doctorPacksBucket: s3.IBucket;
  documentsKey: kms.IKey;
  // F6 — stuck-job watcher Lambda needs RDS access via VPC + secret.
  vpc: ec2.IVpc;
  database: rds.IDatabaseInstance;
  databaseSecurityGroup: ec2.ISecurityGroup;
  databaseSecret: secretsmanager.ISecret;
}

/**
 * Phase 7B-revised closeout item #1: workers stack.
 *
 * Provisions two Python Lambdas that operate downstream of the API:
 *
 *  1. OCR (Textract) — async text extraction. Triggered by EventBridge on S3 PUTs to the
 *     records prefix; starts Textract StartDocumentTextDetection; SNS-subscribed completion
 *     handler POSTs per-page text back to /api/v1/internal/documents/:id/pages.
 *
 *  2. Doctor Pack assembler — SQS-triggered. Reads the manifest from the message body,
 *     pulls source PDFs from the records bucket, renders cover-page + TOC via WeasyPrint,
 *     concatenates the selected page ranges via pypdf, uploads to the server-computed S3
 *     key in the doctor-packs bucket, PATCHes /api/v1/internal/doctor-packs/:id ready.
 *
 * Both Lambdas auth against the API using the shared INTERNAL_WORKER_TOKEN from
 * Secrets Manager.
 *
 * To deploy: `npx cdk deploy compact-emr-staging-workers` (after the API stack is up so
 * the apiBaseUrl is known). Source code lives in `workers/ocr/` and
 * `workers/doctor-pack-assembler/`.
 */
export class WorkersStack extends Stack {
  public readonly doctorPackQueue: sqs.IQueue;
  public readonly doctorPackQueueUrl: string;
  public readonly workerTokenSecret: secretsmanager.ISecret;
  public readonly draftJobQueue: sqs.IQueue;
  public readonly draftJobQueueUrl: string;
  public readonly drafterInvokeTokenSecret: secretsmanager.ISecret;
  public readonly chartExtractQueue: sqs.IQueue;
  public readonly chartExtractQueueUrl: string;
  public readonly jotformIngestQueue: sqs.IQueue;
  public readonly jotformIngestQueueUrl: string;

  constructor(scope: Construct, id: string, props: WorkersStackProps) {
    super(scope, id, props);
    const { config, phiBucket, doctorPacksBucket, documentsKey } = props;
    // C4: the workers' COMPACT_EMR_API_URL must resolve. `https://${config.apiDomainName}`
    // points at api.emr.flatratenexus.com, which is NXDOMAIN (the custom domain was never
    // stood up). Mirror drafter-stack.ts:181's workaround and use the resolving raw
    // execute-api endpoint until the api.emr custom domain (H5) lands as the proper fix.
    const apiBaseUrl = 'https://nypr790pq7.execute-api.us-east-1.amazonaws.com';

    // ===== Shared INTERNAL_WORKER_TOKEN (service-principal bearer for /internal/* routes) =====
    const workerTokenSecret = new secretsmanager.Secret(this, 'WorkerToken', {
      secretName: `compact-emr-${config.envName}/internal-worker-token`,
      description: 'Shared bearer token for /api/v1/internal/* routes. Rotate quarterly.',
      generateSecretString: {
        passwordLength: 48,
        excludePunctuation: true,
      },
    });

    // ===== DRAFTER_INVOKE_TOKEN (higher-privilege; drafter-only route /api/v1/internal/drafter/*) =====
    // Distinct from workerTokenSecret so a worker-token leak can't trigger drafting / metered
    // Anthropic spend / mutation of the legal letter artifact. Rotate independently.
    const drafterInvokeTokenSecret = new secretsmanager.Secret(this, 'DrafterInvokeToken', {
      secretName: `compact-emr-${config.envName}/drafter-invoke-token`,
      description: 'Bearer token for /api/v1/internal/drafter/* routes. Higher privilege than INTERNAL_WORKER_TOKEN - rotate quarterly.',
      generateSecretString: {
        passwordLength: 48,
        excludePunctuation: true,
      },
    });
    this.drafterInvokeTokenSecret = drafterInvokeTokenSecret;

    // ===== Doctor Pack assembler SQS queue (FIFO, content-based dedup) =====
    const dpDlq = new sqs.Queue(this, 'DoctorPackAssemblerDlq', {
      queueName: `compact-emr-${config.envName}-doctor-pack-assembler-dlq.fifo`,
      fifo: true,
      retentionPeriod: Duration.days(14),
    });
    this.workerTokenSecret = workerTokenSecret;

    const doctorPackQueue = new sqs.Queue(this, 'DoctorPackAssemblerQueue', {
      queueName: `compact-emr-${config.envName}-doctor-pack-assembler.fifo`,
      fifo: true,
      contentBasedDeduplication: false, // we set MessageDeduplicationId explicitly to doctorPackId
      visibilityTimeout: Duration.minutes(16), // > Lambda timeout below
      deadLetterQueue: { queue: dpDlq, maxReceiveCount: 3 },
    });
    this.doctorPackQueue = doctorPackQueue;
    this.doctorPackQueueUrl = doctorPackQueue.queueUrl;

    // ===== Jotform intake-ingest queue (FIFO) + worker Lambda =====
    const jotformIngestDlq = new sqs.Queue(this, 'JotformIngestDlq', {
      queueName: `compact-emr-${config.envName}-jotform-ingest-dlq.fifo`,
      fifo: true,
    });
    const jotformIngestQueue = new sqs.Queue(this, 'JotformIngestQueue', {
      queueName: `compact-emr-${config.envName}-jotform-ingest.fifo`,
      fifo: true,
      visibilityTimeout: Duration.minutes(11), // > the worker's 10-min timeout
      deadLetterQueue: { queue: jotformIngestDlq, maxReceiveCount: 3 },
    });
    this.jotformIngestQueue = jotformIngestQueue;
    this.jotformIngestQueueUrl = jotformIngestQueue.queueUrl;

    // API key (read-only) — populated out-of-band via the CLI (persists across deploys). Injected
    // as a deploy-time dynamic ref, same pattern as workerTokenSecret.
    const jotformApiKeySecret = secretsmanager.Secret.fromSecretNameV2(this, 'JotformApiKey', `compact-emr-${config.envName}/jotform-api-key`);
    const jotformIngest = new lambda.Function(this, 'JotformIngest', {
      functionName: `compact-emr-${config.envName}-jotform-ingest`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'workers', 'jotform-ingest')),
      timeout: Duration.minutes(10),
      memorySize: 1024,
      environment: {
        COMPACT_EMR_API_URL: apiBaseUrl,
        INTERNAL_WORKER_TOKEN: workerTokenSecret.secretValue.unsafeUnwrap(),
        RECORDS_BUCKET: phiBucket.bucketName,
        JOTFORM_API_KEY: jotformApiKeySecret.secretValue.unsafeUnwrap(),
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });
    jotformIngest.addEventSource(new eventSources.SqsEventSource(jotformIngestQueue, { batchSize: 1 }));
    phiBucket.grantPut(jotformIngest); // worker only PUTs to intake/<id>/; the EMR assign does the copy
    documentsKey.grantEncryptDecrypt(jotformIngest);
    new sqs.CfnQueuePolicy(this, 'JotformIngestQueuePolicy', {
      queues: [jotformIngestQueue.queueUrl],
      policyDocument: {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: ['sqs:SendMessage', 'sqs:ReceiveMessage', 'sqs:DeleteMessage'], Resource: jotformIngestQueue.queueArn }],
      },
    });

    // ===== Drafter job SQS queue (FIFO) =====
    // ApiStack publishes here when ops_staff hits "Send to drafter"; the long-running Fargate
    // task in this stack (scaffolded separately) consumes one job at a time. Each FRN drafter
    // run is 15-20 min — past Lambda's 15-min ceiling, hence Fargate. Visibility timeout
    // generous (45 min) so a slow run doesn't get redelivered while still in flight.
    // Group ID = caseId (serializes same-case redrafts). Dedup ID = jobId (idempotent enqueue).
    const draftJobDlq = new sqs.Queue(this, 'DraftJobDlq', {
      queueName: `compact-emr-${config.envName}-draft-job-dlq.fifo`,
      fifo: true,
      retentionPeriod: Duration.days(14),
    });

    const draftJobQueue = new sqs.Queue(this, 'DraftJobQueue', {
      queueName: `compact-emr-${config.envName}-draft-job.fifo`,
      fifo: true,
      contentBasedDeduplication: false, // explicit MessageDeduplicationId = jobId
      visibilityTimeout: Duration.minutes(45),
      // 3 attempts then DLQ — transient failures get retried by the spine internally; once
      // the wrapper bubbles a failure to SQS-level, repeated SQS redelivery is unlikely to help.
      deadLetterQueue: { queue: draftJobDlq, maxReceiveCount: 3 },
    });
    this.draftJobQueue = draftJobQueue;
    this.draftJobQueueUrl = draftJobQueue.queueUrl;

    // ===== Chart auto-extract SQS queue (FIFO) + worker Lambda =====
    // When all of a case's docs finish OCR, the /pages route enqueues here; this worker reads the
    // case's documents from the API, runs the content-based extractor, and POSTs grounded items to
    // the merge endpoint (the single writer). Group ID = caseId (serializes re-extractions),
    // Dedup ID = triggerHash (a duplicate enqueue for the same doc-set is a no-op).
    const chartExtractDlq = new sqs.Queue(this, 'ChartExtractDlq', {
      queueName: `compact-emr-${config.envName}-chart-extract-dlq.fifo`,
      fifo: true,
      retentionPeriod: Duration.days(14),
    });
    const chartExtractQueue = new sqs.Queue(this, 'ChartExtractQueue', {
      queueName: `compact-emr-${config.envName}-chart-extract.fifo`,
      fifo: true,
      contentBasedDeduplication: false, // explicit MessageDeduplicationId = triggerHash
      visibilityTimeout: Duration.minutes(6), // > worker timeout below
      deadLetterQueue: { queue: chartExtractDlq, maxReceiveCount: 3 },
    });
    this.chartExtractQueue = chartExtractQueue;
    this.chartExtractQueueUrl = chartExtractQueue.queueUrl;

    // The real Anthropic key lives in the drafter's secret (the api-anthropic-api-key secret is a
    // placeholder). Reference by NAME (it's created in DrafterStack, constructed after this stack —
    // a cross-stack object reference would be a cycle). The worker fetches it at cold start.
    const anthropicKeySecret = secretsmanager.Secret.fromSecretNameV2(
      this, 'ChartExtractAnthropicKey', `compact-emr-${config.envName}/drafter-anthropic-api-key`,
    );

    // Lightweight worker: NO VPC, NO Prisma (it reaches the API + Anthropic + Secrets Manager over
    // public endpoints, exactly like the OCR lambdas). It pulls documents from the API, so it never
    // touches the database directly.
    const chartExtractWorker = new nodejs.NodejsFunction(this, 'ChartExtractWorker', {
      functionName: `compact-emr-${config.envName}-chart-extract`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.resolve(__dirname, '..', '..', 'workers', 'chart-extract', 'handler.ts'),
      handler: 'handler',
      timeout: Duration.minutes(5),
      memorySize: 512,
      environment: {
        COMPACT_EMR_API_URL: apiBaseUrl,
        INTERNAL_WORKER_TOKEN: workerTokenSecret.secretValue.unsafeUnwrap(),
        ANTHROPIC_SECRET_ARN: anthropicKeySecret.secretArn,
        CHART_EXTRACT_MAX_RECEIVE: '3',
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });
    anthropicKeySecret.grantRead(chartExtractWorker);
    // Same bare-ARN-vs-`-??????` defect as the sweep secrets (see JotformSweep IAM note below): this
    // worker reads ANTHROPIC_SECRET_ARN (the bare ARN) via GetSecretValue at cold start, so the
    // grantRead() above can't cover the real request — it works today only by SDK name-resolution
    // luck. Suffix-independent `*` grant makes it deterministic so OCR/chart-extract can't silently
    // die the way the intake sweep did.
    chartExtractWorker.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:compact-emr-${config.envName}/drafter-anthropic-api-key*`],
    }));
    chartExtractWorker.addEventSource(new eventSources.SqsEventSource(chartExtractQueue, { batchSize: 1 }));

    // ===== Textract async completion SNS topic =====
    const textractCompletionTopic = new sns.Topic(this, 'TextractCompletionTopic', {
      topicName: `compact-emr-${config.envName}-textract-completion`,
      displayName: 'Textract async job completion fan-out',
    });

    // The role Textract assumes to publish to the topic.
    const textractSnsRole = new iam.Role(this, 'TextractSnsRole', {
      assumedBy: new iam.ServicePrincipal('textract.amazonaws.com'),
      description: 'Textract uses this to publish StartDocumentTextDetection completions to SNS',
    });
    textractCompletionTopic.grantPublish(textractSnsRole);

    // ===== OCR start handler (S3 EventBridge trigger) =====
    const ocrStart = new lambda.Function(this, 'OcrStart', {
      functionName: `compact-emr-${config.envName}-ocr-start`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.start_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'workers', 'ocr')),
      timeout: Duration.minutes(2),
      memorySize: 256,
      environment: {
        COMPACT_EMR_API_URL: apiBaseUrl,
        INTERNAL_WORKER_TOKEN: workerTokenSecret.secretValue.unsafeUnwrap(),
        COMPLETION_SNS_TOPIC_ARN: textractCompletionTopic.topicArn,
        TEXTRACT_SNS_ROLE_ARN: textractSnsRole.roleArn,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });
    ocrStart.addToRolePolicy(new iam.PolicyStatement({
      actions: ['textract:StartDocumentTextDetection'],
      resources: ['*'],
    }));
    ocrStart.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [textractSnsRole.roleArn],
    }));
    phiBucket.grantRead(ocrStart);
    documentsKey.grantDecrypt(ocrStart);

    // EventBridge rule: PUT into cases/ OR intake/ in the PHI bucket fires the OCR start.
    // C2: case uploads write `cases/<caseId>/<uuid>-<filename>` (documents.ts:99 /
    // s3-key-safety.ts isCaseDocumentS3Key). The prior `records/` prefix never matched
    // any produced key, so ocr-start was never triggered.
    // #8 v2 parse-at-intake: the jotform-ingest worker writes uploads to `intake/<intakeId>/<file>`
    // BEFORE assign — OCR them in place via this same async pipeline so the text is ready by assign
    // (ocr-start branches on the intake/ prefix; there is no Document, so it caches to IntakePage).
    new events.Rule(this, 'OcrStartRule', {
      ruleName: `compact-emr-${config.envName}-ocr-on-record-upload`,
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [phiBucket.bucketName] },
          object: { key: [{ prefix: 'cases/' }, { prefix: 'intake/' }] },
        },
      },
      targets: [new targets.LambdaFunction(ocrStart, { retryAttempts: 2 })],
    });

    // ===== OCR completion handler (SNS subscriber) =====
    const ocrCompletion = new lambda.Function(this, 'OcrCompletion', {
      functionName: `compact-emr-${config.envName}-ocr-completion`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.completion_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'workers', 'ocr')),
      timeout: Duration.minutes(10),
      memorySize: 1024,
      environment: {
        COMPACT_EMR_API_URL: apiBaseUrl,
        INTERNAL_WORKER_TOKEN: workerTokenSecret.secretValue.unsafeUnwrap(),
        COMPLETION_SNS_TOPIC_ARN: textractCompletionTopic.topicArn,
        TEXTRACT_SNS_ROLE_ARN: textractSnsRole.roleArn,
        // Claude OCR fallback (ports the local claude.js ocrSinglePdf): when Textract can't read a
        // file, OCR it with Claude instead of dead-ending to the RN queue. Reversible: set
        // CLAUDE_OCR_FALLBACK=off to revert to Textract-only ("if it breaks we go back").
        RECORDS_BUCKET: phiBucket.bucketName,
        ANTHROPIC_SECRET_ARN: anthropicKeySecret.secretArn,
        CLAUDE_OCR_FALLBACK: 'on',
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });
    ocrCompletion.addToRolePolicy(new iam.PolicyStatement({
      actions: ['textract:GetDocumentTextDetection'],
      resources: ['*'],
    }));
    phiBucket.grantRead(ocrCompletion); // fetch the file bytes for the Claude OCR fallback
    documentsKey.grantDecrypt(ocrCompletion);
    anthropicKeySecret.grantRead(ocrCompletion);
    // Same bare-ARN GetSecretValue defect — the Claude OCR fallback reads ANTHROPIC_SECRET_ARN at
    // runtime. Suffix-independent `*` grant (see chartExtractWorker note) so the fallback can't
    // silently lose Secrets Manager access.
    ocrCompletion.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:compact-emr-${config.envName}/drafter-anthropic-api-key*`],
    }));
    textractCompletionTopic.addSubscription(new subs.LambdaSubscription(ocrCompletion));

    // ===== Doctor Pack assembler Lambda =====
    // The WeasyPrint dependencies (cairo, pango, gobject) require a custom layer.
    // For now we declare the Lambda; the layer ARN is wired via env var DOCTOR_PACK_WEASYPRINT_LAYER_ARN
    // (the operator deploys the layer separately using the official WeasyPrint AWS Lambda layer build).
    const weasyprintLayerArn = process.env['DOCTOR_PACK_WEASYPRINT_LAYER_ARN'];
    const assemblerLayers = weasyprintLayerArn
      ? [lambda.LayerVersion.fromLayerVersionArn(this, 'WeasyPrintLayer', weasyprintLayerArn)]
      : undefined;

    const doctorPackAssembler = new lambda.Function(this, 'DoctorPackAssembler', {
      functionName: `compact-emr-${config.envName}-doctor-pack-assembler`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'workers', 'doctor-pack-assembler')),
      timeout: Duration.minutes(15),
      memorySize: 2048,
      ...(assemblerLayers ? { layers: assemblerLayers } : {}),
      environment: {
        COMPACT_EMR_API_URL: apiBaseUrl,
        INTERNAL_WORKER_TOKEN: workerTokenSecret.secretValue.unsafeUnwrap(),
        RECORDS_BUCKET: phiBucket.bucketName,
        DOCTOR_PACKS_BUCKET: doctorPacksBucket.bucketName,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });
    doctorPackAssembler.addEventSource(new eventSources.SqsEventSource(doctorPackQueue, {
      batchSize: 1, // one pack per invocation; matches the 1:1 row-to-message contract
    }));
    phiBucket.grantRead(doctorPackAssembler);
    doctorPacksBucket.grantPut(doctorPackAssembler);
    doctorPacksBucket.grantPutAcl(doctorPackAssembler);
    documentsKey.grantDecrypt(doctorPackAssembler);

    // ===== Doctor Pack queue access policy =====
    // The API stack reads DOCTOR_PACK_QUEUE_URL / DRAFT_JOB_QUEUE_URL / tokens directly from
    // CDK props (api-stack.ts, fed from bin/compact-emr.ts) — no SSM round-trip involved.
    new sqs.CfnQueuePolicy(this, 'DoctorPackQueuePolicy', {
      queues: [doctorPackQueue.queueUrl],
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'lambda.amazonaws.com' },
            Action: ['sqs:SendMessage', 'sqs:ReceiveMessage', 'sqs:DeleteMessage'],
            Resource: doctorPackQueue.queueArn,
          },
        ],
      },
    });

    // ===== F6: Stuck-Fargate-task watcher Lambda =====
    // Every 5 min: scan DraftJob WHERE state IN ('queued','running') AND heartbeat stale > 10 min,
    // flip to state='failed', failureClass='system'. Without this, a crashed Fargate task
    // leaves the job invisible for 45 min (SQS visibility timeout).
    const watcherSg = new ec2.SecurityGroup(this, 'StuckJobWatcherSecurityGroup', {
      vpc: props.vpc,
      allowAllOutbound: true,
      description: 'Compact EMR stuck-job watcher Lambda egress + DB access.',
    });
    new ec2.CfnSecurityGroupIngress(this, 'DatabaseIngressFromStuckJobWatcher', {
      groupId: props.databaseSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      sourceSecurityGroupId: watcherSg.securityGroupId,
      description: 'Compact EMR stuck-job watcher Lambda to Postgres',
    });

    const watcherLogGroup = new logs.LogGroup(this, 'StuckJobWatcherLogGroup', {
      logGroupName: `/aws/lambda/compact-emr-${config.envName}-stuck-job-watcher`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: config.envName === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // DATABASE_URL identical construction to ApiStack — both Lambdas read the same DB.
    const watcherDatabaseUrl = cdk.Fn.sub(
      'postgresql://{{resolve:secretsmanager:${secretArn}:SecretString:username}}:{{resolve:secretsmanager:${secretArn}:SecretString:password}}@${host}:${port}/compact_emr?schema=public',
      {
        secretArn: props.databaseSecret.secretArn,
        host: props.database.dbInstanceEndpointAddress,
        port: props.database.dbInstanceEndpointPort,
      },
    );

    const stuckJobWatcher = new nodejs.NodejsFunction(this, 'StuckJobWatcher', {
      functionName: `compact-emr-${config.envName}-stuck-job-watcher`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.resolve(__dirname, '..', '..', 'backend', 'src', 'lambdas', 'stuck-job-watcher.ts'),
      handler: 'handler',
      timeout: Duration.minutes(2),
      memorySize: 512,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [watcherSg],
      logGroup: watcherLogGroup,
      environment: {
        ENV_NAME: config.envName,
        DATABASE_URL: watcherDatabaseUrl,
        DATABASE_URL_SECRET_ARN: props.databaseSecret.secretArn,
      },
      bundling: {
        externalModules: ['@prisma/client', '@prisma/engines'],
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => {
            // Same Prisma-binary copy pattern as ApiStack — Node fs.cpSync helper handles
            // POSIX + Windows without xcopy's memory ceiling on @prisma engines.
            const helper = path.join(__dirname, '..', 'scripts', 'bundle-copy.cjs');
            const q = (s: string) => `"${s}"`;
            return [
              `node ${q(helper)} ${q(inputDir + '/backend/node_modules/@prisma')} ${q(outputDir + '/node_modules/@prisma')}`,
              `node ${q(helper)} ${q(inputDir + '/backend/node_modules/.prisma')} ${q(outputDir + '/node_modules/.prisma')}`,
              `node ${q(helper)} ${q(inputDir + '/backend/prisma')} ${q(outputDir + '/prisma')}`,
            ];
          },
        },
      },
    });
    props.databaseSecret.grantRead(stuckJobWatcher);

    new events.Rule(this, 'StuckJobWatcherSchedule', {
      ruleName: `compact-emr-${config.envName}-stuck-job-watcher-schedule`,
      description: 'Every 5 min, sweep DraftJob rows with stale heartbeats to state=failed.',
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [new targets.LambdaFunction(stuckJobWatcher, { retryAttempts: 2 })],
    });

    // ===== F6b: CloudWatch metric filter + alarm on watcher "swept" log lines =====
    // The watcher silently fixes stuck jobs — but if it's sweeping at >3/hr, drafter
    // Fargate is recurring-crashing upstream and we need a human to investigate.
    // (Per RN-self-service rule: alarm goes to ops/Ryan, NOT to RN UI — RNs see the
    // already-handled failed state via their normal queue. This alarm is for "something
    // upstream is wrong" detection, not RN-facing.)
    const sweptMetricFilter = new logs.MetricFilter(this, 'StuckJobWatcherSweptMetric', {
      logGroup: watcherLogGroup,
      // Match the structured log line emitted on each sweep:
      //   { "msg": "stuck-job-watcher: swept", "jobId": ..., ... }
      // Exclude the "no stale jobs" / "summary" logs — only count real sweeps.
      filterPattern: logs.FilterPattern.literal('{ $.msg = "stuck-job-watcher: swept" }'),
      metricNamespace: `compact-emr/${config.envName}/drafter`,
      metricName: 'StuckJobsSwept',
      metricValue: '1',
      defaultValue: 0,
    });

    new cloudwatch.Alarm(this, 'StuckJobsSweptAlarm', {
      alarmName: `compact-emr-${config.envName}-stuck-jobs-swept-high`,
      alarmDescription: 'Drafter Fargate tasks are repeatedly crashing - watcher swept >3 stuck jobs in 1 hour. Investigate Fargate task logs.',
      metric: sweptMetricFilter.metric({
        statistic: 'Sum',
        period: Duration.hours(1),
      }),
      threshold: 3,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ===== G1 + G6: Stuck-DoctorPack watcher Lambda =====
    // Sweeps DoctorPack rows in two stuck states the existing pipeline doesn't recover from:
    //   QUEUED > 5 min (G6: SQS publish failed silently) -> re-publish to SQS
    //   GENERATING > 15 min (G1: assembler crashed) -> flip to 'failed' with RN-friendly msg
    // Same VPC + DB SG pattern as the stuck-job watcher.
    const dpWatcherSg = new ec2.SecurityGroup(this, 'StuckDoctorPackWatcherSecurityGroup', {
      vpc: props.vpc,
      allowAllOutbound: true,
      description: 'Compact EMR stuck-doctor-pack watcher Lambda egress + DB + SQS access.',
    });
    new ec2.CfnSecurityGroupIngress(this, 'DatabaseIngressFromStuckDoctorPackWatcher', {
      groupId: props.databaseSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      sourceSecurityGroupId: dpWatcherSg.securityGroupId,
      description: 'Compact EMR stuck-doctor-pack watcher Lambda to Postgres',
    });

    const dpWatcherLogGroup = new logs.LogGroup(this, 'StuckDoctorPackWatcherLogGroup', {
      logGroupName: `/aws/lambda/compact-emr-${config.envName}-stuck-doctor-pack-watcher`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: config.envName === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    const stuckDoctorPackWatcher = new nodejs.NodejsFunction(this, 'StuckDoctorPackWatcher', {
      functionName: `compact-emr-${config.envName}-stuck-doctor-pack-watcher`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.resolve(__dirname, '..', '..', 'backend', 'src', 'lambdas', 'stuck-doctor-pack-watcher.ts'),
      handler: 'handler',
      timeout: Duration.minutes(2),
      memorySize: 512,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [dpWatcherSg],
      logGroup: dpWatcherLogGroup,
      environment: {
        ENV_NAME: config.envName,
        DATABASE_URL: watcherDatabaseUrl,
        DATABASE_URL_SECRET_ARN: props.databaseSecret.secretArn,
        // Re-publish path needs the DoctorPack queue URL.
        DOCTOR_PACK_QUEUE_URL: doctorPackQueue.queueUrl,
      },
      bundling: {
        externalModules: ['@prisma/client', '@prisma/engines'],
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => {
            const helper = path.join(__dirname, '..', 'scripts', 'bundle-copy.cjs');
            const q = (s: string) => `"${s}"`;
            return [
              `node ${q(helper)} ${q(inputDir + '/backend/node_modules/@prisma')} ${q(outputDir + '/node_modules/@prisma')}`,
              `node ${q(helper)} ${q(inputDir + '/backend/node_modules/.prisma')} ${q(outputDir + '/node_modules/.prisma')}`,
              `node ${q(helper)} ${q(inputDir + '/backend/prisma')} ${q(outputDir + '/prisma')}`,
            ];
          },
        },
      },
    });
    props.databaseSecret.grantRead(stuckDoctorPackWatcher);
    doctorPackQueue.grantSendMessages(stuckDoctorPackWatcher);

    new events.Rule(this, 'StuckDoctorPackWatcherSchedule', {
      ruleName: `compact-emr-${config.envName}-stuck-doctor-pack-watcher-schedule`,
      description: 'Every 5 min, sweep stuck DoctorPack rows (queued -> republish; generating -> fail).',
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [new targets.LambdaFunction(stuckDoctorPackWatcher, { retryAttempts: 2 })],
    });

    // Mirror the F6b CloudWatch alarm pattern: if doctor-pack assembler is recurring-crashing,
    // we want an ops signal. Threshold 2/hr (lower than drafter's 3/hr because doctor-pack
    // failures are rarer in normal operation).
    const dpSweptMetricFilter = new logs.MetricFilter(this, 'StuckDoctorPackSweptMetric', {
      logGroup: dpWatcherLogGroup,
      filterPattern: logs.FilterPattern.literal('{ $.msg = "stuck-doctor-pack-watcher: swept stale generating row" }'),
      metricNamespace: `compact-emr/${config.envName}/drafter`,
      metricName: 'DoctorPacksSweptGenerating',
      metricValue: '1',
      defaultValue: 0,
    });

    new cloudwatch.Alarm(this, 'DoctorPacksSweptAlarm', {
      alarmName: `compact-emr-${config.envName}-doctor-packs-swept-high`,
      alarmDescription: 'Doctor Pack assembler is repeatedly crashing - watcher swept >2 stuck generating rows in 1 hour. Investigate assembler Lambda logs.',
      metric: dpSweptMetricFilter.metric({
        statistic: 'Sum',
        period: Duration.hours(1),
      }),
      threshold: 2,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ===== Jotform intake safety-net sweep (hourly) =====
    // Webhook deliveries can be silently missed (Jotform outage / our 5xx in a deploy window /
    // Jotform auto-disabling a webhook after failures). Every hour, re-list the recent window of
    // submissions and REPLAY them through the live webhook. Idempotent (intakes_submission_uq +
    // the webhook's status-gated re-enqueue), so already-ingested submissions are no-ops and the
    // worker never re-fetches them from Jotform — keeping steady-state load at ~1 list call/hour
    // (the owner's hard constraint: no account lockout). No VPC/DB — talks only to Jotform + our
    // own public webhook. reuses jotformApiKeySecret (declared above).
    const jotformWebhookSecretForSweep = secretsmanager.Secret.fromSecretNameV2(
      this, 'JotformWebhookSecretForSweep', `compact-emr-${config.envName}/jotform-webhook-secret`);
    const jotformSweep = new nodejs.NodejsFunction(this, 'JotformSweep', {
      functionName: `compact-emr-${config.envName}-jotform-sweep`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.resolve(__dirname, '..', '..', 'backend', 'src', 'lambdas', 'jotform-sweep.ts'),
      handler: 'handler',
      timeout: Duration.minutes(2),
      memorySize: 256,
      logRetention: logs.RetentionDays.THREE_MONTHS,
      environment: {
        ENV_NAME: config.envName,
        JOTFORM_API_HOST: 'hipaa-api.jotform.com',
        API_DOMAIN: apiBaseUrl.replace(/^https?:\/\//, '').replace(/\/$/, ''),
        // Pass the FRIENDLY NAME, not `.secretArn`. For a name-imported secret, `.secretArn` is the
        // PARTIAL ARN (no `-XXXXXX` suffix), and Secrets Manager CANNOT resolve a partial ARN —
        // GetSecretValue(partialArn) returns ResourceNotFound (masked as AccessDenied for a scoped
        // role). VERIFIED 2026-06-05: this, not the IAM grant, was why the sweep died on every run.
        // The friendly name resolves to the current secret regardless of suffix; its authz resource
        // is the resolved full ARN, which the `*` grant below covers.
        JOTFORM_API_KEY_SECRET_ARN: jotformApiKeySecret.secretName,
        JOTFORM_WEBHOOK_SECRET_ARN: jotformWebhookSecretForSweep.secretName,
        LOOKBACK_MINUTES: '360',
      },
    });
    // IAM FIX (2026-06-05 incident, defense-in-depth). The ACTUAL blocker was the partial-ARN
    // SecretId above (now passing `.secretName`). This `*` grant is the matching authz: a
    // GetSecretValue-by-name authorizes against the RESOLVED full ARN (`...-XXXXXX`), so the policy
    // resource must cover it. `<name>*` matches the full ARN AND survives a secret delete+recreate
    // (which rotates the suffix) — unlike `fromSecretNameV2(...).grantRead()`, which emits
    // `<bare-arn>-??????` and broke in concert with the partial-ARN read. The old grantRead() calls
    // are replaced, not kept.
    jotformSweep.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
      resources: [
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:compact-emr-${config.envName}/jotform-api-key*`,
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:compact-emr-${config.envName}/jotform-webhook-secret*`,
      ],
    }));

    new events.Rule(this, 'JotformSweepSchedule', {
      ruleName: `compact-emr-${config.envName}-jotform-sweep-schedule`,
      description: 'Hourly: replay the recent window of Jotform submissions through the webhook (safety net).',
      schedule: events.Schedule.rate(Duration.hours(1)),
      targets: [new targets.LambdaFunction(jotformSweep, { retryAttempts: 1 })],
    });

    // A safety net that can die silently is not a safety net — this alarm is what was MISSING when
    // the sweep AccessDenied'd on every run for days with nobody paged. Any sweep invocation error
    // (IAM, Jotform unreachable, code throw) breaches within the hour. No SNS action wired here yet
    // (matches StuckJobsSweptAlarm/DoctorPacksSweptAlarm above — console/dashboard-visible); wire an
    // ops topic subscription when one exists. NOT-breaching on missing data so a paused schedule
    // doesn't false-alarm.
    new cloudwatch.Alarm(this, 'JotformSweepErrorsAlarm', {
      alarmName: `compact-emr-${config.envName}-jotform-sweep-errors`,
      alarmDescription: 'The hourly Jotform intake safety-net sweep is erroring (IAM / Jotform / code). Intake submissions on unregistered forms may be silently dropped. Check /aws/lambda/compact-emr-' + config.envName + '-jotform-sweep.',
      metric: jotformSweep.metricErrors({ statistic: 'Sum', period: Duration.hours(1) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
  }
}
