/**
 * Chart auto-extract: SQS publish. When all of a case's documents finish OCR, the /pages route
 * inserts a ChartExtractionRun (idempotency latch) and publishes a tiny message here; the
 * chart-extract worker Lambda then reads the case's documents, runs the extractor, and POSTs the
 * grounded items to the merge endpoint.
 *
 * Queue: compact-emr-${env}-chart-extract.fifo
 *   Group ID = caseId       (serializes re-extractions for the same case)
 *   Dedup ID = triggerHash  (a duplicate enqueue for the same doc-set is a no-op)
 *
 * Test/local: no-op when NODE_ENV=test or CHART_EXTRACT_QUEUE_URL unset (so the /pages trigger is
 * inert in tests + any env without the queue, never affecting the OCR page write).
 */

export interface ChartExtractQueueMessage {
  readonly runId: string;
  readonly caseId: string;
  readonly veteranId: string;
  readonly triggerHash: string;
}

let cachedClient: unknown = null;

async function getSqsClient(): Promise<unknown> {
  if (cachedClient !== null) return cachedClient;
  const mod = (await import('@aws-sdk/client-sqs')) as unknown as { SQSClient: new (cfg: Record<string, unknown>) => unknown };
  cachedClient = new mod.SQSClient({});
  return cachedClient;
}

export async function publishChartExtractQueued(message: ChartExtractQueueMessage): Promise<{ skipped: boolean; reason?: string }> {
  const queueUrl = process.env['CHART_EXTRACT_QUEUE_URL'];
  if (process.env['NODE_ENV'] === 'test' || !queueUrl) {
    return { skipped: true, reason: queueUrl ? 'NODE_ENV=test' : 'CHART_EXTRACT_QUEUE_URL unset' };
  }
  const client = (await getSqsClient()) as { send: (cmd: unknown) => Promise<unknown> };
  const sdk = (await import('@aws-sdk/client-sqs')) as unknown as {
    SendMessageCommand: new (input: Record<string, unknown>) => unknown;
  };
  const command = new sdk.SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(message),
    MessageGroupId: message.caseId,
    MessageDeduplicationId: message.triggerHash,
  });
  await client.send(command);
  return { skipped: false };
}
