import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cloudwatchActions,
  aws_ec2 as ec2,
  aws_events as events,
  aws_events_targets as targets,
  aws_iam as iam,
  aws_kms as kms,
  aws_lambda as lambda,
  aws_lambda_destinations as destinations,
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
      visibilityTimeout: Duration.minutes(23), // ≥1.5× the 15-min worker timeout (audit 2026-06-13): 16min was only 1.07× → a slow finalizer (post-merge POST + doctor-pack autogen) past 16min could redeliver mid-tail. The worker's runId idempotency guard is the primary double-bill prevention; this is the cushion.
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
      // Full-read chunker: a complete read of a 2,000+ page bundle is ~60 LLM chunk calls. At
      // concurrency 8 that's ~7-9 min; 15 min (Lambda max) is the safety ceiling for the largest
      // cases (Woodley 2,256pp ran 14-17 min at concurrency 4). Visibility (16 min) stays strictly
      // greater so SQS can't re-deliver mid-run and double-process.
      timeout: Duration.minutes(15),
      memorySize: 1024,
      environment: {
        COMPACT_EMR_API_URL: apiBaseUrl,
        INTERNAL_WORKER_TOKEN: workerTokenSecret.secretValue.unsafeUnwrap(),
        ANTHROPIC_SECRET_ARN: anthropicKeySecret.secretArn,
        CHART_EXTRACT_MAX_RECEIVE: '3',
        // Full-read chunker gate (PR-1). PRODUCTION as of 2026-06-13: validated live on a real-veteran
        // cohort (Porter/Bonnewitz/Thomas/Stocks — up to 58 items / 35 chunks, truncatedWindows 0 and
        // uncoveredPages 0 on every run, screening-doc loop confirmed) AFTER the icd10/status/ratingPct
        // write-hardening that closed the transaction-abort class. 'on' = the complete-read path that
        // reads every page; revert to 'off' only to fall back to the legacy header-windower.
        CHART_EXTRACT_FULLREAD: 'on',
        // DIRECT-SC in-service EVENT classifier. LIVE 2026-06-15 (Ryan, monitor-on-real-cases): default
        // graduated 'false'→'true' so the AI event classifier RUNS on real chart extractions and LOGS its
        // grounded events. It is still LOG-ONLY (no write endpoint yet) — it does NOT feed the viability
        // panel or any letter, so it cannot change output; it's on for MONITORING its detection quality on
        // real charts before we wire it into the panel. Cost: one extra Sonnet 4.6 call per chart extract.
        // Revert = default→'false' (or context override) + deploy.
        DIRECT_SC_VIABILITY_ENABLED: (this.node.tryGetContext('direct_sc_viability_enabled') as string | undefined) ?? 'true',
      },
      bundling: {
        // The event classifier loads the vendored eventCanon.cjs at RUNTIME by __dirname-relative path
        // (event-classifier.ts loadEventCanon → event-canon-vendor), so it is NOT esbuild-bundled —
        // copy the vendor tree next to the handler, mirroring the api-stack anchor-vendor copy. Only
        // exercised on the dark path, but the copy must exist before the flag can flip.
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => {
            const helper = path.join(__dirname, '..', 'scripts', 'bundle-copy.cjs');
            const q = (s: string) => `"${s}"`;
            return [
              `node ${q(helper)} ${q(inputDir + '/backend/src/vendor')} ${q(outputDir + '/event-canon-vendor')}`,
            ];
          },
        },
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
      // Layer 1 native-PDF read (2026-06-14): ocr-start extracts a PDF's embedded text layer inline
      // (pypdf) instead of always firing Textract. A digital VA Blue Button dump (Lozano: 2,294 pages /
      // ~3M chars) extracts in ~22s AT A FULL vCPU — RAM is a non-issue (peak ~55MB).
      // Per-page VISION (2026-06-16): when CLAUDE_VISION_SCANNED_PAGES=on, a SCANNED file is read page-by-
      // page by Claude Sonnet INLINE here (no async). Up to VISION_MAX_PAGES pages/file at
      // VISION_CONCURRENCY parallelism — so the budget is raised to 2048MB / 15min to cover the worst
      // single oversized scanned upload (larger files fall through to Textract). Tiny .txt/.docx/normal
      // invocations still finish sub-second, so the bigger budget costs ~nothing.
      timeout: Duration.minutes(15),
      memorySize: 2048,
      environment: {
        COMPACT_EMR_API_URL: apiBaseUrl,
        INTERNAL_WORKER_TOKEN: workerTokenSecret.secretValue.unsafeUnwrap(),
        COMPLETION_SNS_TOPIC_ARN: textractCompletionTopic.topicArn,
        TEXTRACT_SNS_ROLE_ARN: textractSnsRole.roleArn,
        // Per-page Claude VISION for scanned pages (the silent-content-loss fix). Runs INLINE in
        // start_handler → ocr-start needs the Anthropic key + the PHI bucket (granted below). SONNET for
        // every scanned page (Ryan 2026-06-16: reliability > cost; ~$2/100 scanned pp, ~$0 born-digital).
        // tier1==escalate==Sonnet → one Sonnet call/page, no Haiku tier. DARK until the flag flips to 'on'.
        RECORDS_BUCKET: phiBucket.bucketName,
        ANTHROPIC_SECRET_ARN: anthropicKeySecret.secretArn,
        // FLIPPED ON 2026-06-16 after the dark deploy + migration confirmed live. Revert to 'off' to
        // fall back to Textract-only ("if it breaks we go back") — no image rebuild needed.
        CLAUDE_VISION_SCANNED_PAGES: 'on',
        CLAUDE_VISION_MODEL: 'claude-sonnet-4-6',
        CLAUDE_VISION_ESCALATE_MODEL: 'claude-sonnet-4-6',
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
    // Per-page vision (2026-06-16) reads the file bytes (granted above) + the Anthropic key at runtime.
    // Mirror the ocr-completion Claude grants: suffix-independent `*` GetSecretValue so the bare-ARN read
    // can't silently lose access (same defect class noted on ocr-completion / chart-extract).
    anthropicKeySecret.grantRead(ocrStart);
    ocrStart.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:compact-emr-${config.envName}/drafter-anthropic-api-key*`],
    }));

    // ===== Package 4a orphan-race fix: ocr-start async-failure DLQ + depth alarm =====
    // ocr-start now RAISES on an unresolvable cases/ key (the Document row lands a beat after
    // the S3 object — recordDocument race), so the Lambda async retry re-resolves it. A
    // genuinely dead key (Document deleted) exhausts the retries and would then VANISH — the
    // exact silent-skip class this package kills. The onFailure destination captures the
    // exhausted event in a DLQ; the alarm below makes it loud. Standard (non-FIFO) queue:
    // Lambda async destinations don't support FIFO.
    const ocrStartDlq = new sqs.Queue(this, 'OcrStartDlq', {
      queueName: `compact-emr-${config.envName}-ocr-start-dlq`,
      retentionPeriod: Duration.days(14),
    });
    ocrStart.configureAsyncInvoke({
      onFailure: new destinations.SqsDestination(ocrStartDlq),
      retryAttempts: 2, // explicit (the async-invoke default) — the retry backoff IS the orphan-race grace
    });

    // Loud, not silent (mirrors JotformSweepErrorsAlarm below): any message in the DLQ means a
    // cases/ upload was never OCR'd after all retries. No SNS action wired yet — console/
    // dashboard-visible like the other worker alarms; wire an ops topic when one exists.
    new cloudwatch.Alarm(this, 'OcrStartDlqDepthAlarm', {
      alarmName: `compact-emr-${config.envName}-ocr-start-dlq-depth`,
      alarmDescription: 'An ocr-start async invocation exhausted its retries and landed in the DLQ — a cases/ upload has no resolvable Document (deleted, or recordDocument never ran) and was NOT OCRd. Inspect compact-emr-' + config.envName + '-ocr-start-dlq messages for the S3 key, then re-fire OCR (CopyObject-onto-self) once the Document exists.',
      metric: ocrStartDlq.metricApproximateNumberOfMessagesVisible({
        statistic: 'Maximum',
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

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
    // ===== OCR completion SNS subscription DLQ + depth alarm =====
    // Without a DLQ, an SNS→Lambda delivery that keeps failing (e.g. the completion's /pages POST 500s)
    // is retried by SNS then SILENTLY DROPPED — exactly how a successfully-OCR'd doc (Lozano's 6MB PDF,
    // 2026-06) was lost and its case stranded in ocr_in_progress with no trace. Capture the undeliverable
    // message so it's loud + recoverable, never silent. (QA 2026-06-13.)
    const ocrCompletionDlq = new sqs.Queue(this, 'OcrCompletionDlq', {
      queueName: `compact-emr-${config.envName}-ocr-completion-dlq`,
      retentionPeriod: Duration.days(14),
    });
    textractCompletionTopic.addSubscription(new subs.LambdaSubscription(ocrCompletion, {
      deadLetterQueue: ocrCompletionDlq,
    }));
    new cloudwatch.Alarm(this, 'OcrCompletionDlqDepthAlarm', {
      alarmName: `compact-emr-${config.envName}-ocr-completion-dlq-depth`,
      alarmDescription: 'An ocr-completion SNS delivery exhausted retries and landed in the DLQ — a Textract completion (page text or the read-attempt-failed flag) was NOT recorded, so a doc may be stranded non-terminal. The stuck-doc watcher auto-recovers this; inspect compact-emr-' + config.envName + '-ocr-completion-dlq for the raw message.',
      metric: ocrCompletionDlq.metricApproximateNumberOfMessagesVisible({
        statistic: 'Maximum',
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ===== Errors alarms on BOTH OCR Lambdas (the only Errors alarm in the account was jotform-sweep) =====
    // ocr-start RAISES intentionally on the recordDocument orphan race (self-heals on retry), so require a
    // SUSTAINED error (3 periods) before breaching — a single transient raise must not page. ocr-completion
    // has no such intended-raise, so a tighter 2-period alarm is correct there.
    new cloudwatch.Alarm(this, 'OcrStartErrorsAlarm', {
      alarmName: `compact-emr-${config.envName}-ocr-start-errors`,
      alarmDescription: 'ocr-start is erroring on a SUSTAINED basis (beyond the benign recordDocument-race retry) — record uploads may not be starting OCR.',
      metric: ocrStart.metricErrors({ statistic: 'Sum', period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, 'OcrCompletionErrorsAlarm', {
      alarmName: `compact-emr-${config.envName}-ocr-completion-errors`,
      alarmDescription: 'ocr-completion is erroring — Textract completions may not be recording page text or the read-attempt-failed flag (the SNS DLQ above captures the dropped messages).',
      metric: ocrCompletion.metricErrors({ statistic: 'Sum', period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ===== Ops alerting: SNS topic + DLQ-depth alarms on the four previously-SILENT queues =====
    // Whole-pipeline audit 2026-06-13 (3-agent finding): the chart-extract / jotform-ingest / draft-job /
    // doctor-pack DLQs had NO depth alarm, and NO alarm in the account had an SNS action (the ocr-start DLQ
    // sat RED ~36h unseen). One ops topic + a depth alarm on each silent DLQ so a poisoned intake, a failed
    // extract, a failed draft, or a failed doctor-pack is LOUD + PAGED — never silent. (Subscribe/confirm the
    // ops email; existing OCR alarms should also get .addAlarmAction(opsTopic) as a trivial follow-up.)
    const opsTopic = new sns.Topic(this, 'OpsAlertsTopic', {
      topicName: `compact-emr-${config.envName}-ops-alerts`,
      displayName: 'Compact EMR ops alerts (DLQ depth + Lambda errors)',
    });
    // Default ops destination = the FRN inbox. AWS emails a confirmation link to info@ that must be clicked
    // before alarms deliver. Change/add destinations (SMS, a dedicated ops address) as desired.
    opsTopic.addSubscription(new subs.EmailSubscription('info@flatratenexus.com'));
    const dlqDepthAlarm = (id: string, alarmName: string, queue: sqs.IQueue, what: string): void => {
      const a = new cloudwatch.Alarm(this, id, {
        alarmName,
        alarmDescription: `${what} landed in its DLQ after exhausting retries — investigate the source logs + redrive. (whole-pipeline audit 2026-06-13)`,
        metric: queue.metricApproximateNumberOfMessagesVisible({ statistic: 'Maximum', period: Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      a.addAlarmAction(new cloudwatchActions.SnsAction(opsTopic));
    };
    dlqDepthAlarm('ChartExtractDlqDepthAlarm', `compact-emr-${config.envName}-chart-extract-dlq-depth`, chartExtractDlq, 'A chart-extraction message');
    dlqDepthAlarm('JotformIngestDlqDepthAlarm', `compact-emr-${config.envName}-jotform-ingest-dlq-depth`, jotformIngestDlq, 'A Jotform intake-ingest message');
    dlqDepthAlarm('DraftJobDlqDepthAlarm', `compact-emr-${config.envName}-draft-job-dlq-depth`, draftJobDlq, 'A drafter job');
    dlqDepthAlarm('DoctorPackAssemblerDlqDepthAlarm', `compact-emr-${config.envName}-doctor-pack-assembler-dlq-depth`, dpDlq, 'A doctor-pack assembly message');

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

    // ===== Stuck-DOCUMENT watcher Lambda (Ryan 2026-06-13: never stuck, never silent, never babysit) =====
    // Every 5 min: find a Document with NO pages + NO terminal file_read_status, uploaded > 20 min ago —
    // the inert-stuck class that pinned Woodley/Lozano in ocr_in_progress INVISIBLY (no RN-queue entry,
    // no error, no alarm). Re-fire OCR once by invoking ocr-start with a synthetic ObjectCreated event;
    // if a prior re-fire still didn't land a terminal row, flag manual (loud + RN-visible). Reuses the
    // stuck-job watcher's SG + DB-URL construction (same DB, same VPC).
    const stuckDocLogGroup = new logs.LogGroup(this, 'StuckDocWatcherLogGroup', {
      logGroupName: `/aws/lambda/compact-emr-${config.envName}-stuck-doc-watcher`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: config.envName === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    const stuckDocWatcher = new nodejs.NodejsFunction(this, 'StuckDocWatcher', {
      functionName: `compact-emr-${config.envName}-stuck-doc-watcher`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.resolve(__dirname, '..', '..', 'backend', 'src', 'lambdas', 'stuck-doc-watcher.ts'),
      handler: 'handler',
      timeout: Duration.minutes(2),
      memorySize: 512,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [watcherSg],
      logGroup: stuckDocLogGroup,
      environment: {
        ENV_NAME: config.envName,
        DATABASE_URL: watcherDatabaseUrl,
        DATABASE_URL_SECRET_ARN: props.databaseSecret.secretArn,
        RECORDS_BUCKET: phiBucket.bucketName,
        OCR_START_FUNCTION_NAME: ocrStart.functionName,
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
    props.databaseSecret.grantRead(stuckDocWatcher);
    ocrStart.grantInvoke(stuckDocWatcher); // re-fire OCR via a synthetic ObjectCreated invoke

    new events.Rule(this, 'StuckDocWatcherSchedule', {
      ruleName: `compact-emr-${config.envName}-stuck-doc-watcher-schedule`,
      description: 'Every 5 min, re-fire (once) or flag-manual any Document stuck with no terminal read status.',
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [new targets.LambdaFunction(stuckDocWatcher, { retryAttempts: 2 })],
    });

    // Loud when the watcher GIVES UP on a file (re-fire didn't heal → flagged manual): a sustained stream
    // means an OCR class we can't auto-read. Metric-filter on the structured give-up log line.
    const sweptToManualMetric = stuckDocLogGroup.addMetricFilter('StuckDocSweptToManualMetric', {
      filterPattern: logs.FilterPattern.literal('{ $.msg = "stuck-doc-watcher: swept to manual after re-fire timed out" }'),
      metricNamespace: `compact-emr-${config.envName}/ocr`,
      metricName: 'StuckDocSweptToManual',
      metricValue: '1',
    });
    new cloudwatch.Alarm(this, 'StuckDocSweptToManualAlarm', {
      alarmName: `compact-emr-${config.envName}-stuck-doc-swept-to-manual`,
      alarmDescription: 'The stuck-doc watcher gave up on one+ files (auto-OCR + a re-fire both failed) and flagged them for manual summary — investigate the file type / OCR path if this is sustained.',
      metric: sweptToManualMetric.metric({ statistic: 'Sum', period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ===== Stuck-CHART-EXTRACTION-RUN watcher Lambda (audit 2026-06-13: never stuck, never silent) =====
    // Every 5 min: find a ChartExtractionRun still status IN ('queued','running') with createdAt > 45 min
    // — a run whose worker Lambda was killed abnormally (OOM / init crash / DLQ exhaustion) before posting
    // a terminal status. Without this, deriveChartBuildState pins the case in 'extracting' FOREVER,
    // invisibly (the extraction analogue of the stuck-doc/stuck-job nets). Flip it to status='failed' so the
    // door shows the retryable 'extract_failed' state. Pure DB sweep — reuses the stuck-job watcher's SG +
    // DB-URL construction (same DB, same VPC), no OCR invoke or queue send needed.
    const stuckExtractRunLogGroup = new logs.LogGroup(this, 'StuckChartExtractRunWatcherLogGroup', {
      logGroupName: `/aws/lambda/compact-emr-${config.envName}-stuck-chart-extract-run-watcher`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: config.envName === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    const stuckExtractRunWatcher = new nodejs.NodejsFunction(this, 'StuckChartExtractRunWatcher', {
      functionName: `compact-emr-${config.envName}-stuck-chart-extract-run-watcher`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.resolve(__dirname, '..', '..', 'backend', 'src', 'lambdas', 'stuck-chart-extract-run-watcher.ts'),
      handler: 'handler',
      timeout: Duration.minutes(2),
      memorySize: 512,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [watcherSg],
      logGroup: stuckExtractRunLogGroup,
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
    props.databaseSecret.grantRead(stuckExtractRunWatcher);

    new events.Rule(this, 'StuckChartExtractRunWatcherSchedule', {
      ruleName: `compact-emr-${config.envName}-stuck-chart-extract-run-watcher-schedule`,
      description: 'Every 5 min, fail any ChartExtractionRun stuck non-terminal > 45 min so the door shows extract_failed (retryable), not a silent permanent "extracting".',
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [new targets.LambdaFunction(stuckExtractRunWatcher, { retryAttempts: 2 })],
    });

    // Loud when the watcher reaps a stuck run: a sustained stream means worker Lambdas are dying before
    // posting (OOM / timeout class), not isolated incidents. Metric-filter on the structured swept line.
    const extractRunSweptMetric = stuckExtractRunLogGroup.addMetricFilter('StuckChartExtractRunSweptMetric', {
      filterPattern: logs.FilterPattern.literal('{ $.msg = "stuck-chart-extract-run-watcher: swept" }'),
      metricNamespace: `compact-emr-${config.envName}/chart-extract`,
      metricName: 'StuckChartExtractRunsSwept',
      metricValue: '1',
    });
    const extractRunSweptAlarm = new cloudwatch.Alarm(this, 'StuckChartExtractRunSweptAlarm', {
      alarmName: `compact-emr-${config.envName}-stuck-chart-extract-run-swept`,
      alarmDescription: 'The stuck-chart-extract-run watcher failed one+ runs that never posted a terminal status (worker killed before the merge callback) — investigate the worker timeout/OOM if sustained.',
      metric: extractRunSweptMetric.metric({ statistic: 'Sum', period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    extractRunSweptAlarm.addAlarmAction(new cloudwatchActions.SnsAction(opsTopic));

    // ===== F7: RN Advisory cabinet loader Lambda (Approach A) =====
    // Manually invoked (`aws lambda invoke`). Idempotently builds the pgvector "cabinet" (advisory
    // schema + ref_chunk + HNSW + the two NOLOGIN roles) AND loads the embedded library that the
    // flatratenexus window drops at s3://<phiBucket>/advisory/advisory_chunks_embedded.jsonl. Runs
    // in-VPC as the RDS master; the flatratenexus window NEVER connects to RDS. No EventBridge schedule
    // — it's a one-shot (re-runnable; setup is IF-NOT-EXISTS, load is ON CONFLICT DO NOTHING).
    const advisoryLoaderSg = new ec2.SecurityGroup(this, 'AdvisoryLoaderSecurityGroup', {
      vpc: props.vpc,
      allowAllOutbound: true,
      description: 'Compact EMR advisory cabinet loader Lambda egress + DB access.',
    });
    new ec2.CfnSecurityGroupIngress(this, 'DatabaseIngressFromAdvisoryLoader', {
      groupId: props.databaseSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      sourceSecurityGroupId: advisoryLoaderSg.securityGroupId,
      description: 'Compact EMR advisory loader Lambda to Postgres',
    });
    const advisoryLoaderLogGroup = new logs.LogGroup(this, 'AdvisoryLoaderLogGroup', {
      logGroupName: `/aws/lambda/compact-emr-${config.envName}-advisory-loader`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: config.envName === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    // The advisory_ro DB login secret (auto-generated password, alphanumeric so it's URL-safe in the
    // ask-path DATABASE_URL). The loader sets advisory_ro's LOGIN password from this; the ask-path API
    // Lambda will read it (by friendly name) to connect AS advisory_ro — a dedicated read-only identity,
    // NOT SET ROLE on a pool (architect gap #1).
    const advisoryRoSecret = new secretsmanager.Secret(this, 'AdvisoryRoDbSecret', {
      secretName: `compact-emr-${config.envName}/advisory-ro-db`,
      description: 'Password for the advisory_ro read-only DB login (the AI ask-path identity).',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'advisory_ro' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 32,
      },
    });

    const advisoryLoader = new nodejs.NodejsFunction(this, 'AdvisoryLoader', {
      functionName: `compact-emr-${config.envName}-advisory-loader`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.resolve(__dirname, '..', '..', 'backend', 'src', 'lambdas', 'advisory-loader.ts'),
      handler: 'handler',
      timeout: Duration.minutes(10),
      memorySize: 1024,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [advisoryLoaderSg],
      logGroup: advisoryLoaderLogGroup,
      environment: {
        ENV_NAME: config.envName,
        DATABASE_URL: watcherDatabaseUrl, // same DB, identical construction to the watcher / ApiStack
        ADVISORY_DROP_BUCKET: props.phiBucket.bucketName,
        ADVISORY_DROP_KEY: 'advisory/advisory_chunks_embedded.jsonl',
        ADVISORY_RO_SECRET_NAME: advisoryRoSecret.secretName,
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
    props.databaseSecret.grantRead(advisoryLoader);
    props.phiBucket.grantRead(advisoryLoader, 'advisory/*'); // read ONLY the advisory drop prefix
    advisoryRoSecret.grantRead(advisoryLoader); // loader reads it to set advisory_ro's LOGIN password

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
        LOOKBACK_MINUTES: '1440', // 24h (audit 2026-06-13): 360min left a silent gap if BOTH the webhook missed a submit AND the sweep was down >6h; idempotent, steady-state cost unchanged.
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
