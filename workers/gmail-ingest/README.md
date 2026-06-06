# gmail-ingest — inbound email poller (Feature B) — STAGED, NOT YET DEPLOYED

This worker pulls new mail from Google Workspace mailboxes and feeds the EMR's read-only Email log. It
is **intentionally not yet wired into `infra/lib/workers-stack.ts`** — wiring an unverified Lambda that
bundles `google-auth-library` into `cdk deploy --all` could fail the whole staging deploy. The log UI +
endpoints + migration already ship and work; this is the one piece that needs a deliberate, verified
enable step. **It has NOT been run against a live Workspace — verify before trusting it.**

## How it works
- One **service account with domain-wide delegation** impersonates each monitored mailbox (Gmail
  `readonly`). "Easily add staff emails" = add an address to the SSM StringList; no per-mailbox OAuth.
- Polls `newer_than:1d` per mailbox, uploads raw + attachments to `phiBucket emails/<id>/` (id derived
  from the RFC Message-ID → idempotent), then POSTs each to `POST /api/v1/internal/emails/ingest`, which
  dedupes on Message-ID, matches the veteran, and inserts the row.
- **Self-gates**: empty mailbox list OR placeholder service-account secret → logs "not configured",
  no-op. Safe to deploy idle.

## Ryan's one-time Google Workspace setup (cannot be automated)
1. Google Cloud console: create a **service account**; create a **JSON key**.
2. Enable **domain-wide delegation** on it; in the Workspace Admin console (Security → API controls →
   Domain-wide delegation) authorize its **client ID** for scope
   `https://www.googleapis.com/auth/gmail.readonly`.
3. Put the JSON key into Secrets Manager `compact-emr/<env>/gmail-workspace-sa`.
4. Set the SSM StringList `/compact-emr/<env>/monitored-mailboxes` to `info@…,admin@…` (+ each staff
   address as hired). Editing this list is how you add mailboxes later — no redeploy.

## CDK to add to `infra/lib/workers-stack.ts` (mirror jotform-sweep — read the secret by NAME)
```ts
// Operator-populated placeholder (persists across deploys). READ BY FRIENDLY NAME at runtime — never
// fromSecretNameV2(...).secretArn (the partial-ARN AccessDenied footgun, 2026-06-05).
const gmailSaSecretName = `compact-emr-${config.envName}/gmail-workspace-sa`;
const mailboxesParam = `/compact-emr/${config.envName}/monitored-mailboxes`; // SSM StringList, default ''

const gmailIngest = new nodejs.NodejsFunction(this, 'GmailIngest', {
  functionName: `compact-emr-${config.envName}-gmail-ingest`,
  entry: path.join(__dirname, '..', '..', 'workers', 'gmail-ingest', 'handler.mjs'),
  runtime: lambda.Runtime.NODEJS_20_X,
  timeout: cdk.Duration.minutes(5),
  memorySize: 512,
  environment: {
    MONITORED_MAILBOXES_PARAM: mailboxesParam,
    GMAIL_SA_SECRET_NAME: gmailSaSecretName,           // friendly name, not ARN
    PHI_BUCKET_NAME: phiBucket.bucketName,
    EMR_API_BASE: props.internalApiBaseUrl,            // same base the OCR workers POST to
    INTERNAL_WORKER_TOKEN: '',                         // inject from the existing worker-token secret
  },
  bundling: { externalModules: [] },                   // bundle google-auth-library
});
phiBucket.grantPut(gmailIngest);
gmailIngest.addToRolePolicy(new iam.PolicyStatement({
  actions: ['secretsmanager:GetSecretValue'],
  resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:${gmailSaSecretName}*`], // <name>* suffix
}));
gmailIngest.addToRolePolicy(new iam.PolicyStatement({
  actions: ['ssm:GetParameter'], resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${mailboxesParam}`],
}));
new events.Rule(this, 'GmailIngestSchedule', {
  schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
  targets: [new targets.LambdaFunction(gmailIngest)],
});
// + a CloudWatch Errors alarm (mirror the jotform-sweep alarm) so a dead poller is never silent.
```

## Verify before enabling
1. Populate the SA secret + add ONE test mailbox to the SSM list.
2. Send a test email from a known veteran's address to that mailbox.
3. Invoke the Lambda (or wait for the schedule); confirm a row appears in the veteran's Email tab and a
   second invocation is a `deduped:true` no-op (idempotency). Confirm a blank SSM list = no-op.
