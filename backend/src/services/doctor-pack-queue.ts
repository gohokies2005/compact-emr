/**
 * Phase 7B-revised closeout item #2: SQS publish for the Doctor Pack assembler worker.
 *
 * When POST /api/v1/cases/:id/doctor-pack/generate creates a queued DoctorPack row, this
 * service publishes an SQS message carrying the doctorPackId + manifest + pdfS3Key so the
 * assembler Lambda picks it up. The worker (workers/doctor-pack-assembler/handler.py) reads
 * the manifest from the SQS body — no API GET round-trip needed.
 *
 * In test mode (NODE_ENV=test OR DOCTOR_PACK_QUEUE_URL unset) this is a no-op: the route
 * still creates the queued row, but no SQS message fires. Production deploys set
 * DOCTOR_PACK_QUEUE_URL to the assembler queue URL produced by the WorkersStack CDK.
 *
 * Failure mode: SQS send errors do NOT roll back the DoctorPack row. The row stays in
 * state='queued' and an admin can retry by hitting /generate again (which will 409 on the
 * partial-unique index — they'll need to flip the stale queued row to failed first). A
 * future hardening would be: SQS-publish-via-outbox-table (transactional outbox pattern).
 */

interface DoctorPackQueueMessage {
  readonly doctorPackId: string;
  readonly caseId: string;
  readonly pdfS3Key: string;
  readonly manifest: unknown;
}

let cachedClient: unknown = null;

async function getSqsClient(): Promise<unknown> {
  if (cachedClient !== null) return cachedClient;
  // Lazy-import @aws-sdk/client-sqs so unit tests (which don't need it) don't pay the
  // ~3 MB load. The runtime Lambda includes it via the API stack's bundling.
  const mod = (await import('@aws-sdk/client-sqs')) as unknown as { SQSClient: new (cfg: Record<string, unknown>) => unknown };
  cachedClient = new mod.SQSClient({});
  return cachedClient;
}

export async function publishDoctorPackQueued(message: DoctorPackQueueMessage): Promise<{ skipped: boolean; reason?: string }> {
  const queueUrl = process.env['DOCTOR_PACK_QUEUE_URL'];
  if (process.env['NODE_ENV'] === 'test' || !queueUrl) {
    return { skipped: true, reason: queueUrl ? 'NODE_ENV=test' : 'DOCTOR_PACK_QUEUE_URL unset' };
  }

  const client = (await getSqsClient()) as { send: (cmd: unknown) => Promise<unknown> };
  const sdk = await import('@aws-sdk/client-sqs') as unknown as { SendMessageCommand: new (input: Record<string, unknown>) => unknown };
  const command = new sdk.SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify({
      doctorPackId: message.doctorPackId,
      caseId: message.caseId,
      pdfS3Key: message.pdfS3Key,
      manifest: message.manifest,
    }),
    // Use the doctorPackId as the dedup key (FIFO queue with content-based dedup).
    MessageDeduplicationId: message.doctorPackId,
    MessageGroupId: message.caseId,
  });
  await client.send(command);
  return { skipped: false };
}
