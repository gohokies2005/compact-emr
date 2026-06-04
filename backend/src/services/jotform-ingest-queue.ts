/**
 * SQS publish for the Jotform intake-ingest worker. The webhook (a doorbell) records an Intake row
 * + publishes {intakeId, formId, submissionId}; the worker (workers/jotform-ingest) fetches the
 * authoritative submission + files from the Jotform HIPAA API BY ID and lands them in S3.
 * See docs/JOTFORM_INTAKE_INGESTION_SPEC.md.
 *
 * FIFO: MessageGroupId = submissionId (each submission is independent → max parallelism; a constant
 * group id would serialize ALL intake globally). DedupId = submissionId (matches the Intake unique
 * key, so a duplicate webhook is a no-op end to end).
 *
 * No-op in tests / when JOTFORM_INGEST_QUEUE_URL is unset (the webhook still records the row).
 * Send errors do NOT roll back the row — it stays 'pending' for re-enqueue by a future fire/sweep.
 */

interface JotformIngestMessage {
  readonly intakeId: string;
  readonly formId: string;
  readonly submissionId: string;
}

let cachedClient: unknown = null;

async function getSqsClient(): Promise<unknown> {
  if (cachedClient !== null) return cachedClient;
  const mod = (await import('@aws-sdk/client-sqs')) as unknown as { SQSClient: new (cfg: Record<string, unknown>) => unknown };
  cachedClient = new mod.SQSClient({});
  return cachedClient;
}

export async function publishJotformIngest(message: JotformIngestMessage): Promise<{ skipped: boolean; reason?: string }> {
  const queueUrl = process.env['JOTFORM_INGEST_QUEUE_URL'];
  if (process.env['NODE_ENV'] === 'test' || !queueUrl) {
    return { skipped: true, reason: queueUrl ? 'NODE_ENV=test' : 'JOTFORM_INGEST_QUEUE_URL unset' };
  }
  const client = (await getSqsClient()) as { send: (cmd: unknown) => Promise<unknown> };
  const sdk = (await import('@aws-sdk/client-sqs')) as unknown as { SendMessageCommand: new (input: Record<string, unknown>) => unknown };
  const command = new sdk.SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify({ intakeId: message.intakeId, formId: message.formId, submissionId: message.submissionId }),
    MessageDeduplicationId: message.submissionId,
    MessageGroupId: message.submissionId,
  });
  await client.send(command);
  return { skipped: false };
}
