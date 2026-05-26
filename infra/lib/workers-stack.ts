import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  aws_events as events,
  aws_events_targets as targets,
  aws_iam as iam,
  aws_kms as kms,
  aws_lambda as lambda,
  aws_lambda_event_sources as eventSources,
  aws_logs as logs,
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

  constructor(scope: Construct, id: string, props: WorkersStackProps) {
    super(scope, id, props);
    const { config, phiBucket, doctorPacksBucket, documentsKey } = props;
    const apiBaseUrl = `https://${config.apiDomainName}`;

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
      description: 'Bearer token for /api/v1/internal/drafter/* routes. Higher privilege than INTERNAL_WORKER_TOKEN — rotate quarterly.',
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

    // EventBridge rule: PUT into records/ in the PHI bucket fires the OCR start.
    new events.Rule(this, 'OcrStartRule', {
      ruleName: `compact-emr-${config.envName}-ocr-on-record-upload`,
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [phiBucket.bucketName] },
          object: { key: [{ prefix: 'records/' }] },
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
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });
    ocrCompletion.addToRolePolicy(new iam.PolicyStatement({
      actions: ['textract:GetDocumentTextDetection'],
      resources: ['*'],
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

    // ===== Wire the queue URL + worker token into outputs the API stack consumes =====
    // The API stack reads DOCTOR_PACK_QUEUE_URL + INTERNAL_WORKER_TOKEN from env; pass via
    // SSM parameters in the operator's bin/* file (out of scope here — keeps the layer
    // composition explicit).
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
  }
}
