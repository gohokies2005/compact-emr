/**
 * Concrete RenderInvoker — synchronously invokes the render Lambda (built from the FRN repo,
 * Dockerfile.render) which runs the dumb pdfgen/docxgen and PutObjects the artifacts to S3.
 * Wired into createLetterRouter at mount (server.ts) from env RENDER_LAMBDA_NAME. Injected so
 * the router has no @aws-sdk/client-lambda dependency at type-check time + is stub-testable.
 */

import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import type { RenderInvoker, RenderInvokeInput, RenderInvokeResult } from '../routes/letter.js';

let cachedClient: LambdaClient | null = null;
function client(): LambdaClient {
  if (cachedClient === null) cachedClient = new LambdaClient({});
  return cachedClient;
}

export function makeRenderInvoker(functionName: string): RenderInvoker {
  return async (input: RenderInvokeInput): Promise<RenderInvokeResult> => {
    const res = await client().send(new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(input), 'utf-8'),
    }));
    if (res.FunctionError !== undefined) {
      const detail = res.Payload ? Buffer.from(res.Payload).toString('utf-8') : '(no payload)';
      throw new Error(`render Lambda FunctionError ${res.FunctionError}: ${detail.slice(0, 500)}`);
    }
    if (res.Payload === undefined) throw new Error('render Lambda returned no payload');
    const parsed = JSON.parse(Buffer.from(res.Payload).toString('utf-8')) as RenderInvokeResult;
    if (parsed === null || typeof parsed !== 'object' || parsed.ok !== true) {
      throw new Error(`render Lambda did not return ok: ${JSON.stringify(parsed).slice(0, 300)}`);
    }
    return parsed;
  };
}
