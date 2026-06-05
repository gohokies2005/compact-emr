/**
 * Drafter integration: SQS publish for the long-running drafter Fargate task.
 *
 * When POST /api/v1/cases/:id/draft creates a queued DraftJob row, this service publishes
 * an SQS message carrying just the jobId + caseId + version (+ optional strategyOverride
 * for redrafts). The drafter wrapper then hits GET /api/v1/cases/:id/drafter-export to pull
 * the full materialization bundle. Tiny message, full bundle on-demand — keeps SQS messages
 * small and lets the wrapper share one export endpoint with future "re-materialize" needs.
 *
 * Queue: compact-emr-${env}-draft-job.fifo
 *   Group ID = caseId       (serializes same-case redrafts so v2 never starts before v1 ends)
 *   Dedup ID = jobId        (idempotent enqueue — retried POST /draft becomes a no-op)
 *
 * Test/local: no-op when NODE_ENV=test or DRAFT_JOB_QUEUE_URL unset.
 */

interface DraftJobQueueMessage {
  readonly jobId: string;
  readonly caseId: string;
  readonly version: number;
  // Architect QA F1: bundleS3Key points at the materialization bundle in
  // s3://<phi-bucket>/drafter-exports/<caseId>/<jobId>.json. The Fargate wrapper reads
  // it directly using its phiBucket task role grant — no API round-trip needed.
  readonly bundleS3Key: string;
  readonly strategyOverride?: string | null;
  readonly parentVersion?: number | null;
  // Gate-2 resume: the RN's decision rides the NEW draft-job message so the drafter SKIPS the
  // dx-verification gate (no loop). Exactly one of gate2Override / switchToCondition / proceed.
  readonly rnDecision?: {
    readonly gate2Override?: boolean;
    readonly switchToCondition?: string;
    readonly proceed?: boolean;
    readonly reason?: string;
    readonly rnUser?: string;
  } | null;
}

let cachedClient: unknown = null;

async function getSqsClient(): Promise<unknown> {
  if (cachedClient !== null) return cachedClient;
  const mod = (await import('@aws-sdk/client-sqs')) as unknown as { SQSClient: new (cfg: Record<string, unknown>) => unknown };
  cachedClient = new mod.SQSClient({});
  return cachedClient;
}

export async function publishDraftJobQueued(message: DraftJobQueueMessage): Promise<{ skipped: boolean; reason?: string }> {
  const queueUrl = process.env['DRAFT_JOB_QUEUE_URL'];
  if (process.env['NODE_ENV'] === 'test' || !queueUrl) {
    return { skipped: true, reason: queueUrl ? 'NODE_ENV=test' : 'DRAFT_JOB_QUEUE_URL unset' };
  }

  const client = (await getSqsClient()) as { send: (cmd: unknown) => Promise<unknown> };
  const sdk = (await import('@aws-sdk/client-sqs')) as unknown as {
    SendMessageCommand: new (input: Record<string, unknown>) => unknown;
  };
  const body: Record<string, unknown> = {
    jobId: message.jobId,
    caseId: message.caseId,
    version: message.version,
    bundleS3Key: message.bundleS3Key,
  };
  if (message.strategyOverride !== undefined && message.strategyOverride !== null) {
    body['strategyOverride'] = message.strategyOverride;
  }
  if (message.parentVersion !== undefined && message.parentVersion !== null) {
    body['parentVersion'] = message.parentVersion;
  }
  if (message.rnDecision !== undefined && message.rnDecision !== null) {
    body['rnDecision'] = message.rnDecision;
  }
  const command = new sdk.SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(body),
    MessageDeduplicationId: message.jobId,
    MessageGroupId: message.caseId,
  });
  await client.send(command);
  return { skipped: false };
}
