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
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cloudwatchActions,
  aws_sns as sns,
} from 'aws-cdk-lib';
import type { CompactEmrConfig } from './config.js';
import { DRAFTER_MAX_CONCURRENCY } from './drafter-constants.js';

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

    // Stripe webhook SIGNING secret (whsec_) — operator-populated AFTER deploy (you add the webhook
    // endpoint in the Stripe dashboard Webhooks section, Stripe hands you the secret, you paste it
    // here). Read at runtime by FRIENDLY NAME (never partial ARN — the AccessDenied footgun). This is
    // the ONLY Stripe secret the core payment→delivery chain needs (no sk_ key — a signature-verified
    // event is trusted; the sk_/restricted key is only for the future poller).
    const stripeWebhookSecret = new secretsmanager.Secret(this, 'StripeWebhookSecret', {
      secretName: `compact-emr-${props.config.envName}/stripe-webhook-secret`,
    });

    // Quo (formerly OpenPhone) SMS transport API key — operator-populated AFTER deploy (same lifecycle
    // as the Stripe/Gmail secrets: CDK creates the secret with a random placeholder and NEVER owns the
    // value, so it survives redeploys). Read at RUNTIME by FRIENDLY NAME (quoClient.readSecretByName via
    // QUO_API_KEY_SECRET_NAME) — never a partial ARN (the AccessDenied footgun). Tier-1 additive SMS
    // (letter-ready text + case-create contact sync) fails soft to {sent:false,no_api_key} until populated.
    const quoApiKeySecret = new secretsmanager.Secret(this, 'QuoApiKeySecret', {
      secretName: `compact-emr-${props.config.envName}/quo-api-key`,
    });

    // Gmail OAuth grant for the outbound-email transport (EMAIL_TRANSPORT=gmail — SES production
    // access denied 2026-06-11, case 178094063100860; Gmail is BAA-covered under Google Workspace).
    // Operator-populated AFTER deploy (same lifecycle as the Anthropic/Stripe secrets — CDK never
    // owns the value, so it persists across deploys). JSON value shape:
    //   {"client_id":"…","client_secret":"…","refresh_token":"…","user":"info@flatratenexus.com"}
    // Read at RUNTIME by friendly name (mailer.readSecretByName) — never env-injected (audit INF-2).
    const gmailOauthSecret = new secretsmanager.Secret(this, 'GmailOauthSecret', {
      secretName: `compact-emr-${props.config.envName}/gmail-oauth`,
    });

    // NCBI E-utilities API key (Citation Enricher / grounded retrieval in routes/letter.ts →
    // citationFallback.cjs). PRE-EXISTING secret created out-of-band (NOT CDK-owned): friendly
    // name 'frn/ncbi-api-key', full ARN ...-c8E88t. The vendored citationFallback.cjs reads
    // process.env.NCBI_API_KEY PER-REQUEST; the key raises the NCBI rate 3/s -> 10/s + improves
    // reliability (keyless already works today, so this is a speed/reliability upgrade). Imported
    // by COMPLETE ARN (fromSecretCompleteArn) for the grantRead IAM symmetry — NOT fromSecretNameV2
    // (partial-ARN footgun, INCIDENTS 2026-06-05). The env-var INJECTION below uses the friendly-name
    // {{resolve}} CFN dynamic reference (same idiom as JOTFORM_WEBHOOK_SECRET above) because the
    // consumer reads it as a plain process.env value, not via a runtime GetSecretValue call.
    const ncbiApiKeySecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'NcbiApiKeySecret',
      'arn:aws:secretsmanager:us-east-1:676591241787:secret:frn/ncbi-api-key-c8E88t',
    );

    // Google Ads offline-conversion upload (routes/intakes.ts paid-intake assign →
    // services/google-ads-conversions.ts getCreds() → readSecretByName(GOOGLE_ADS_SECRET_NAME) at
    // RUNTIME). Unlike the NCBI key above (deploy-time {{resolve}}), this is a genuine runtime
    // GetSecretValue call, so the grantRead below is LOAD-BEARING, not symmetry. Secret created
    // out-of-band (NOT CDK-owned): friendly name 'frn/google-ads-credentials', full ARN ...-zLEsSM.
    // Imported by COMPLETE ARN (fromSecretCompleteArn) — NOT fromSecretNameV2 (partial-ARN footgun,
    // INCIDENTS 2026-06-05). Missing this grant silently zeroed ALL Google Ads conversion tracking:
    // AccessDenied on GetSecretValue -> getCreds JSON.parse('') throws -> caught at intakes.ts -> no
    // upload, no conversion, forever. Root-caused + fixed 2026-07-01.
    const googleAdsSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'GoogleAdsSecret',
      'arn:aws:secretsmanager:us-east-1:676591241787:secret:frn/google-ads-credentials-zLEsSM',
    );

    // Meta (Facebook) CAPI offline-conversion upload (routes/intakes.ts paid-intake assign →
    // services/meta-conversions.ts getCreds() → readSecretByName(META_CAPI_SECRET_NAME) at RUNTIME).
    // Runtime GetSecretValue call → the grantRead below is LOAD-BEARING. Secret created out-of-band
    // (NOT CDK-owned): friendly name 'frn/meta-capi-credentials', full ARN ...-TLAetA, value =
    // { pixel_id, access_token }. Imported by COMPLETE ARN (fromSecretCompleteArn) — not
    // fromSecretNameV2 (partial-ARN footgun, INCIDENTS 2026-06-05). Sibling of the Google Ads secret;
    // same offline-conversion pattern for the Meta side. Added 2026-07-01.
    const metaCapiSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'MetaCapiSecret',
      'arn:aws:secretsmanager:us-east-1:676591241787:secret:frn/meta-capi-credentials-TLAetA',
    );

    const handler = new nodejs.NodejsFunction(this, 'PlaceholderApiLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.resolve(__dirname, '../../backend/src/placeholder-lambda.ts'),
      handler: 'handler',
      // HttpApi still caps SYNCHRONOUS requests at ~30s (the client gets a 504 past that), and synchronous
      // LLM calls remain bounded by their own 26s timeoutMs — so this longer Lambda timeout is consumed ONLY
      // by the async self-invoke recompute path (InvocationType:'Event', see recompute-viability-trigger.ts),
      // which runs the route-picker OFF the API-Gateway request path. That async invoke needs the longer
      // budget to complete the picker on large charts (Zimmelman). 210s (2026-07-15, Kimbrough
      // CLM-41E9900FB8): a 2,345-page chart's plan call runs past the old 75s client budget, and the
      // grounded SOAP precompute in the SAME invocation needs ~50s more — 120s total forced a
      // plan-vs-SOAP squeeze. 210 = 110s plan + ~90s SOAP + margin; sync requests are still capped
      // far lower by API GW (~30s) and per-call client timeouts, so only the async recompute uses this.
      timeout: Duration.seconds(210),
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
        // Drafter concurrency cap, mirrored from the SAME const that sets the Fargate autoscaler
        // maxCapacity in drafter-stack.ts. The draft-concurrency endpoint reads this to tell a
        // queued draft whether the drafter is genuinely full (running === max). Single source ⇒ the
        // UI threshold can never drift from the real ceiling. Backend falls back to 6 if unset.
        DRAFTER_MAX_CONCURRENCY: String(DRAFTER_MAX_CONCURRENCY),
        CHART_EXTRACT_QUEUE_URL: props.chartExtractQueue.queueUrl,
        JOTFORM_INGEST_QUEUE_URL: props.jotformIngestQueue.queueUrl,
        // Shared secret in the Jotform webhook URL path (enables the webhook to accept). Populated
        // out-of-band via CLI. Use a RAW friendly-name CFN dynamic reference — fromSecretNameV2 emits
        // a partial-ARN form that CloudFormation failed to resolve ("ResourceNotFound") for this
        // secret on deploy; the friendly-name form resolves reliably + is env-portable. (2026-06-04.)
        JOTFORM_WEBHOOK_SECRET: `{{resolve:secretsmanager:compact-emr-${props.config.envName}/jotform-webhook-secret:SecretString}}`,
        // NCBI E-utilities API key for the Citation Enricher / grounded retrieval (citationFallback.cjs
        // reads process.env.NCBI_API_KEY per-request). Plain-string secret (the bare key, no JSON), so
        // the {{resolve}} form has no JSON key — identical idiom to JOTFORM_WEBHOOK_SECRET above. Raises
        // NCBI rate 3/s -> 10/s; keyless still works, so a missing value degrades gracefully (the
        // enricher reaches NCBI keyless today). Friendly-name resolve avoids the partial-ARN footgun.
        NCBI_API_KEY: '{{resolve:secretsmanager:frn/ncbi-api-key:SecretString}}',
        // Chart auto-extract: 'on' makes the merge endpoint WRITE extracted rows into the chart
        // (non-destructive: planMerge protects manual + prior-extracted rows; the keystone pkg-6
        // dedup guard in normalizeName collapses the PTSD-variant explosion). DEFAULT IS NOW 'on'
        // (keystone pkg 6 flip, Ryan-authorized conditioned on the guard). KILL SWITCH: cdk.json
        // context `chart_autofill: "off"` or `cdk deploy --context chart_autofill=off` → back to
        // shadow mode (extract + record, zero chart writes). DEPLOY IMPLICATION: this env rides the
        // API task def — the flip takes effect on the next API-stack deploy, after which EVERY
        // completing extraction writes rows into live charts (staging first, eyeball a real case's
        // resultJson, then prod).
        // The draft-readiness DOOR (DRAFT_READINESS_GATE) stays separate + off until the popup ships.
        CHART_AUTOFILL: (this.node.tryGetContext('chart_autofill') as string | undefined) ?? 'on',
        // P4 anchor-viability surface (caseViability v1) — bundle stamp + RN CaseViabilityCard.
        // LIVE 2026-06-14 (Ryan): default graduated 'false'→'true' so the RN-facing viability panel
        // is durably ON (a --context flip would silently revert on the next `cdk deploy --all`). The
        // panel is READ-ONLY advisory; revert = set default back to 'false' (or context override) +
        // deploy (the backend reads it at request time; no image rebuild).
        EMR_CASE_VIABILITY_ENABLED: (this.node.tryGetContext('case_viability_enabled') as string | undefined) ?? 'true',
        // DIRECT-SC viability axis (2026-06-14): folds the direct (in-service-event) axis into the
        // caseViability resolve+rank, emitting caseViability v2 (two-table provenance). ORTHOGONAL to
        // EMR_CASE_VIABILITY_ENABLED (which gates the whole stamp). When off, deriveCaseViability is
        // byte-identical v1. LIVE 2026-06-14 (Ryan, eyeball): default graduated 'false'→'true' on the
        // API ONLY — the panel's direct read is DETERMINISTIC (eventCanon over Case intake fields), no
        // LLM, no per-case cost. The chart-extract event CLASSIFIER (workers-stack) reads the SAME flag
        // but stays 'false' there (it's log-only / not yet fed into viability — no point paying for it).
        // Revert = default→'false' + deploy (read at request time; no image rebuild).
        // Was TEMPORARILY 'false' 2026-06-15 (Ryan, Pichette): the direct fold manufactured a TERA->OSA
        // "directly supports" read + a FALSE burn-pit presumptive redirect. BACK ON 2026-06-15 after the
        // one-brain fix shipped (re-vendor FRN 4acf1e9: exposure events ABSTAIN on an unknown pair +
        // killed the event-class presumptive redirect — presumptive is gated on the condition-keyed
        // _PRESUMPTIVE map, not the exposure class). Verified through the EMR vendored copy: Pichette
        // (OSA + Tinnitus SC + burn-pit + TERA) = weak, no anchor, no presumptive redirect.
        DIRECT_SC_VIABILITY_ENABLED: (this.node.tryGetContext('direct_sc_viability_enabled') as string | undefined) ?? 'true',
        // SC-STATUS PROVENANCE (Woodley fix, 2026-06-26). The consumer trust gate (buildGrantedScAnchors →
        // effectiveScStatus) runs in the API; this flag gates the DEMOTION of a non-authoritative extracted
        // grant to claimed_unverified. DARK by default ('off' = byte-identical pass-through). Must match the
        // worker's SC_PROVENANCE_ENFORCED; flip both together AFTER validating on Woodley. Context-overridable.
        SC_PROVENANCE_ENFORCED: (this.node.tryGetContext('sc_provenance_enforced') as string | undefined) ?? 'off',
        // BRIDGE-ANCHOR pathway (2026-06-16, FRN 859d2eb). The presumptive two-hop suggestion (exposure
        // → PACT-presumptive intermediate dx → claimed secondary; burn-pit → chronic sinusitis/rhinitis/
        // asthma → OSA). ADDITIVE: only attaches on the v2 (direct-axis) shape, so it's meaningful only
        // alongside DIRECT_SC_VIABILITY_ENABLED; OFF leaves the v2 object byte-identical. LIVE 2026-06-16
        // (default 'false'→'true', Ryan) after the engine was verified through the EMR vendored copy
        // (flag-ON Pichette-class → 1 bridge: Chronic rhinosinusitis→OSA, 38 CFR 3.320, physician-review).
        // Read at request time — revert = default→'false' + deploy, no image rebuild.
        BRIDGE_ANCHOR_ENABLED: (this.node.tryGetContext('bridge_anchor_enabled') as string | undefined) ?? 'true',
        // Doctor-pack grounded source pages (PR-1..PR-4, 2026-06-13): map every extracted chart fact
        // back to the EXACT source page that grounded it and pull those pages into the physician pack
        // (the rating-grant page, the sleep-study AHI, the med list) — protected in the page budget
        // (policy-b: capped-but-protected, lowest-yield-fact trimmed last) + cover why-lines, and the
        // Opus LLM page-picker is narrowed off bulk/Blue-Button docs (the $0 back-map owns them). Default
        // 'on' (Ryan-authorized flip). KILL SWITCH: cdk.json context `doctor_pack_grounded_pages: "off"`
        // → byte-identical to the pre-feature pack. Read at request time in doctor-pack-generate (no image
        // rebuild). LIVE SMOKE owed: regenerate a Blue-Button case's pack + confirm the grant/AHI/med pages
        // + cover why-lines appear; physician review is the backstop, revert is one context flip.
        DOCTOR_PACK_GROUNDED_PAGES: (this.node.tryGetContext('doctor_pack_grounded_pages') as string | undefined) ?? 'on',
        // DOCTOR_PACK_CATEGORY_FLOORS (2026-06-26): the "5 evidence categories" abridged-notes fix — per-
        // category presence-gated floors (clinical/sc_proof/denial/tests/lay) + 30-page budget + chart-fact
        // category override so the SC-list/denial/study/statement pages can't be budget-starved, plus the
        // cover "Required evidence checklist". OFF = byte-identical (clinical-only floor, 15-page budget).
        // Read at request time in doctor-pack-generate (no image rebuild); revert is one context flip.
        DOCTOR_PACK_CATEGORY_FLOORS: (this.node.tryGetContext('doctor_pack_category_floors') as string | undefined) ?? 'off',
        // DOCTOR_PACK_LINKED_COVER (2026-06-27): the calm clickable table-of-contents cover — a short
        // case-snapshot header + contents grouped by the five evidence categories, each row a friendly
        // (filename-free) label with ONE predicted page ref. A coverLinkMap travels on the manifest so
        // the Python assembler stamps a PDF link (cover row → that document's first page) + a 2-level
        // outline. OFF (default) = byte-identical legacy text cover, no link-map. The Python side keys
        // off link-map PRESENCE (flag-agnostic). Read at request time in doctor-pack-generate (no image
        // rebuild); dark-deploy then validate on a real pack before flipping.
        DOCTOR_PACK_LINKED_COVER: (this.node.tryGetContext('doctor_pack_linked_cover') as string | undefined) ?? 'off',
        // DOCTOR_PACK_LLM_BULK (2026-07-11): route large bulk/blue_button dumps THROUGH the page-picker
        // (chunked Haiku 4.5) instead of the regex short-circuit — so a sleep study buried in a
        // Blue-Button export is actually surfaced — AND render real per-doc cover descriptors + a
        // claim-filtered/deduped problem snapshot. Runs INLINE on the 30s API path; bounded (page cap +
        // bounded concurrency + throttle backoff) and FAIL-SAFE (never fewer pages than the regex
        // selector). OFF = byte-identical to today (bulk → regex). Read at request time (no image
        // rebuild); revert is one context flip. KILL SWITCH: cdk.json `doctor_pack_llm_bulk: "off"`.
        DOCTOR_PACK_LLM_BULK: (this.node.tryGetContext('doctor_pack_llm_bulk') as string | undefined) ?? 'off',
        // Guided Revision (physician highlight-the-passage broader letter edit, Opus 4.8) — ON (Ryan
        // 2026-06-14: "guided revision looks good, but not available"). Context-overridable to disable.
        GUIDED_REVISION_ENABLED: (this.node.tryGetContext('guided_revision_enabled') as string | undefined) ?? 'true',
        // AI_ROUTE_PICKER_ENABLED (Ryan 2026-06-19): the Overview viability CARD's deriveAiViability
        // (ai-viability.ts → GET /api/v1/cases/:id/viability-card) runs the SAME LLM route-picker brain
        // as the drafter and surfaces the AI's anchor/theory pick alongside the static viability. This
        // runs IN THE API LAMBDA, so the flag must live HERE — not just on the drafter task def. Baked
        // as a graduated default ('true') with a context override so a normal `cdk deploy --all` keeps
        // it ON (a bare --context flip would silently revert on the next converge). Read at request time
        // (no image rebuild). TOGGLE OFF (CDK-permanent): set the default to 'false' (or pass
        // --context ai_route_picker_enabled=off / set it in cdk.json) + deploy. The drafter carries the
        // same flag in drafter-stack.ts; flip both to fully disable the route-picker brain.
        AI_ROUTE_PICKER_ENABLED: (this.node.tryGetContext('ai_route_picker_enabled') as string | undefined) ?? 'true',
        // VETERAN_THEORY_AI_ENABLED (Ryan 2026-07-11, Part B "Ankle nowhere"): the lazy physician
        // GET /cases/:id/veteran-theory endpoint runs a Sonnet restatement of the veteran's OWN theory,
        // grounded in their statement. Runs IN THE API LAMBDA, so the flag lives HERE (not the drafter task
        // def). Default 'false' → ships DARK (no call, no spend). The flag MUST live in this CDK env map so
        // enabling it survives a converge — a bare Lambda-console env edit would be silently reverted by the
        // next `cdk deploy --all` (the out-of-band-resource footgun). Read at request time (no image rebuild).
        // TURN ON: pass --context veteran_theory_ai_enabled=true (or set it in cdk.json) + deploy. Display-only;
        // never influences the drafter (enforced by veteran-theory-drafter-isolation.test.ts).
        VETERAN_THEORY_AI_ENABLED: (this.node.tryGetContext('veteran_theory_ai_enabled') as string | undefined) ?? 'false',
        // SOAP_MECHANISM_VERDICT_ENABLED (Ryan 2026-07-22): the mechanism viability verdict — a bold
        // MEDICALLY VIABLE / BORDERLINE / NOT-SUPPORTABLE-AS-FRAMED lead on the SOAP Assessment, grounded
        // in the library/PubMed retrieval. Recommendation ONLY (never gates a draft); fail-open; computed
        // in the async SOAP precompute (Opus call, off the 25s sync open). Default 'true' → LIVE. Like the
        // flag above it lives in THIS CDK env map so it survives a converge (a console env edit would be
        // reverted by the next `cdk deploy --all`). REVERT: pass --context soap_mechanism_verdict_enabled=false
        // + deploy (or set it in cdk.json). Note: the flag is NOT in soapNoteFingerprint, so existing stored
        // notes only pick up the verdict when they next recompute (schema bump or a per-case recompute).
        SOAP_MECHANISM_VERDICT_ENABLED: (this.node.tryGetContext('soap_mechanism_verdict_enabled') as string | undefined) ?? 'true',
        // NEGATIVE_PAIRINGS_ADVISORY (Ryan 2026-07-22): surfaces the curated negative-pairing "not supportable +
        // reason + counterargument + PMIDs" block in Ask Aegis (recommendation-only, fail-open). Default 'on' →
        // LIVE. Kill-switch: pass --context negative_pairings_advisory=false + deploy (or set in cdk.json) to
        // flip off without a code change. Mirrors the drafter's FRN_NEGATIVE_PAIRINGS.
        NEGATIVE_PAIRINGS_ADVISORY: (this.node.tryGetContext('negative_pairings_advisory') as string | undefined) ?? 'on',
        // PAIRING_STRENGTH_ADVISORY (Ryan 2026-07-22): the POSITIVE counterpart — surfaces the physician-graded
        // pairing STRENGTH ("library grade STRONG/MODERATE… + baseline + deciding PMIDs") in Ask Aegis so an
        // established pairing is backed by default (recommendation-only, fail-open, grade never a directive).
        // Default 'on' → LIVE. Kill-switch: --context pairing_strength_advisory=false + deploy. The verdict
        // consumes the same registry directly (not flag-gated there — the grade is just guidance to the model).
        PAIRING_STRENGTH_ADVISORY: (this.node.tryGetContext('pairing_strength_advisory') as string | undefined) ?? 'on',
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
        // Ask Aegis ask-path: a DEDICATED read-only connection AS advisory_ro (SELECT-only on
        // advisory.ref_chunk — the architect's #1 landmine: never SET ROLE on a pool). Friendly-name
        // {{resolve}} for the password (NOT a partial ARN — see the JOTFORM note above); host/port via Fn.sub.
        ADVISORY_RO_DATABASE_URL: cdk.Fn.sub(
          `postgresql://advisory_ro:{{resolve:secretsmanager:compact-emr-${props.config.envName}/advisory-ro-db:SecretString:password}}@\${host}:\${port}/compact_emr`,
          { host: props.database.dbInstanceEndpointAddress, port: props.database.dbInstanceEndpointPort },
        ),
        // Ask Aegis coverage gate = LLM (Haiku) folder-picker instead of the cosine floor: a folder hit
        // (synonym/alt-name robust) uses that library folder, a miss falls to live PubMed. Fail-open to
        // the legacy cosine path, so 'off' or any picker error restores prior behavior. (Ryan 2026-07-21.)
        ADVISORY_FOLDER_PICKER: 'on',
        // Letter editor: surgical-AI key (runtime-fetched from this ARN) + render Lambda name
        // (only set once the render image exists, so the mount wires the invoker only then).
        API_ANTHROPIC_KEY_SECRET_ARN: apiAnthropicSecret.secretArn,
        // Stripe payment → password-portal PDF delivery (Ryan 2026-06-06).
        STRIPE_WEBHOOK_SECRET_NAME: `compact-emr-${props.config.envName}/stripe-webhook-secret`,
        // Quo SMS: secret read at runtime by friendly name; QUO_FROM is the public 757 number (not a secret).
        QUO_API_KEY_SECRET_NAME: `compact-emr-${props.config.envName}/quo-api-key`,
        QUO_FROM: '+17575401077',
        STRIPE_LINK_500: 'https://buy.stripe.com/3cI9ALcMG5LH05Y3Xm0Ba03', // public payment link (not a secret)
        STRIPE_LINK_350: 'https://buy.stripe.com/aFa5kvaEygql5qi9hG0Ba01', // $350 letter fee payment link (not a secret)
        SES_FROM_ADDRESS: 'info@flatratenexus.com',                          // From address (verified SES identity AND the Gmail OAuth user)
        // Outbound transport: 'gmail' (default — BAA-covered Workspace send as info@) or anything
        // else for SES (sandbox until the production-access appeal lands). Flip via cdk.json context.
        EMAIL_TRANSPORT: (this.node.tryGetContext('email_transport') as string | undefined) ?? 'gmail',
        GMAIL_OAUTH_SECRET_NAME: `compact-emr-${props.config.envName}/gmail-oauth`,
        GOOGLE_ADS_SECRET_NAME: 'frn/google-ads-credentials', // developer_token, client_id, client_secret, refresh_token
        META_CAPI_SECRET_NAME: 'frn/meta-capi-credentials', // { pixel_id, access_token } — Meta CAPI offline Purchase upload
        DELIVERY_PORTAL_BASE_URL: `https://${props.config.domainName}`,      // /d/<token> lives on the SPA
        DELIVERY_ADMIN_BCC: 'admin@flatratenexus.com',
        // SES-SANDBOX forwarding mode (Ryan 2026-06-10): all veteran emails delivered to this inbox
        // instead, [FWD to <real>] prefixed, staff forwards manually within a few hours. Clear the
        // cdk.json value + deploy to disable once SES production access (case 178094063100860) lands.
        EMAIL_REDIRECT_ALL_TO: (this.node.tryGetContext('email_redirect_all_to') as string | undefined) ?? '',
        ...(renderImageTag ? { RENDER_LAMBDA_NAME: renderFnName } : {}),
      },
      bundling: {
        externalModules: ['@prisma/client', '@prisma/engines', 'pg-native'], // pg-native is pg's optional native client; keep it external so esbuild uses the pure-JS path
        commandHooks: {
          // Regenerate the Prisma client from schema.prisma AT BUNDLE TIME so the copied
          // backend/node_modules/.prisma (afterBundling) is ALWAYS current. Without this, a schema
          // enum/model change not followed by a manual `prisma generate` ships a STALE client and the
          // deployed client rejects new values with a client-side PrismaClientValidationError even
          // though the source schema + DB have them (Davis `revised_import`, 2026-07-18). It ALSO closes
          // the asset-hash blind spot: node_modules changes don't bump the source hash, so regenerating
          // locally never forced a redeploy on its own — adding this generate to the bundling spec does.
          beforeBundling: (inputDir: string) => {
            const q = (s: string) => `"${s}"`;
            return [
              `node ${q(inputDir + '/backend/node_modules/prisma/build/index.js')} generate --schema=${q(inputDir + '/backend/prisma/schema.prisma')}`,
            ];
          },
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
              // Advisory (Ask Aegis): the vendored CJS retrieve modules are NOT bundled (they read data
              // files by __dirname-relative path), so copy the whole tree next to the handler. The wrapper
              // loads it at runtime from <task>/advisory-vendor.
              `node ${q(helper)} ${q(inputDir + '/backend/src/advisory/vendor')} ${q(outputDir + '/advisory-vendor')}`,
              // P4 anchor-viability: the vendored CJS resolver + table are NOT bundled (the
              // resolver reads its table by __dirname-relative path) — copy them next to the
              // handler; case-viability.ts loads <task>/anchor-vendor at runtime (advisory pattern).
              // The whole vendor tree is copied, so the DIRECT-SC additions (directSc.cjs +
              // sc_direct_pairs.json) AND eventCanon.cjs (the event floor) ride along automatically —
              // anchorMechanism.cjs lazy-requires ./directSc.cjs and case-viability.ts loads
              // ./eventCanon.cjs from this same dir on the gated direct-SC path.
              `node ${q(helper)} ${q(inputDir + '/backend/src/vendor')} ${q(outputDir + '/anchor-vendor')}`,
            ];
          },
        },
      }
    });

    // Off-request AI-viability compute (Ryan 2026-06-19): the API Lambda invokes ITSELF asynchronously to
    // compute the route-picker plan off the 29s request path (the picker call can't fit under the cap
    // synchronously). Needs its own name to invoke + permission to invoke itself. Blast radius: api only.
    // NOTE: do NOT add SELF_FUNCTION_NAME = handler.functionName — putting the Lambda's own name (a CFN Ref
    // to itself) into its OWN environment makes the function self-reference → CloudFormation "Circular
    // dependency" with every API-GW permission/integration that depends on the Lambda. The code instead reads
    // the reserved AWS-provided env var AWS_LAMBDA_FUNCTION_NAME (always set by Lambda) — no self-ref needed.
    // Self-invoke permission WITHOUT a circular dependency: grant on a CONSTRUCTED name-pattern ARN
    // (a plain string from stack metadata, no resource ref) — granting on the function object would cycle.
    handler.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:${Stack.of(this).partition}:lambda:${Stack.of(this).region}:${Stack.of(this).account}:function:${Stack.of(this).stackName}-*`],
    }));
    // The async route-picker recompute (InvocationType:'Event') is SELF-RETRYING by design — the FE re-fires on
    // the next GET and a genuine compute failure stamps an honest 'error'/Retry. AWS-level async retries (default
    // 2) would only re-drive a slow/failing picker into 2 MORE full Sonnet computes (~5¢ each) on exactly the
    // slow cases we target, defeating the in-flight dedup. Disable them; cap event age so a stale queued event
    // can't fire a pointless compute minutes later.
    handler.configureAsyncInvoke({ retryAttempts: 0, maxEventAge: Duration.seconds(60) });

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

    // Ask Aegis: invoke Opus 4.6 (the answer) + Titan-v2 (the query embedding) on Bedrock.
    handler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: ['*'], // InvokeModel-only (read inference); tighten to the model + inference-profile ARNs later
    }));

    // Stripe + delivery: read the webhook signing secret at runtime; send the portal email via SES.
    stripeWebhookSecret.grantRead(handler);
    // Gmail transport: read the OAuth grant at runtime (friendly name; CDK-created so the full ARN
    // grant resolves — not the fromSecretNameV2 partial-ARN footgun).
    gmailOauthSecret.grantRead(handler);
    // Quo SMS transport: read the API key at runtime (CDK-created secret object → full-ARN grant, never
    // the fromSecretNameV2 partial-ARN footgun).
    quoApiKeySecret.grantRead(handler);
    // NCBI key: the env var above is resolved by CloudFormation at deploy time (a {{resolve}} dynamic
    // reference, NOT a runtime GetSecretValue), so the Lambda role does NOT strictly need GetSecretValue
    // to READ it. This grant is kept for IAM symmetry + forward-compat if the enricher ever switches to a
    // runtime fetch; it writes secretsmanager:GetSecretValue on the exact ...-c8E88t ARN (complete-ARN
    // import → no partial-ARN footgun). Harmless if unused.
    ncbiApiKeySecret.grantRead(handler);
    // Google Ads conversion upload: read the OAuth creds at RUNTIME (getCreds -> readSecretByName).
    // Load-bearing (NOT symmetry): without it every paid-intake conversion upload fails at the secret
    // read (AccessDenied). Complete-ARN import => GetSecretValue on the exact ...-zLEsSM ARN, no
    // partial-ARN footgun. This one grant unblocks the whole offline-conversion pipeline.
    googleAdsSecret.grantRead(handler);
    // Meta CAPI conversion upload: read the pixel_id + access_token at RUNTIME. Load-bearing (same as
    // the Google grant above) — without it every Facebook-sourced conversion upload fails at the secret
    // read. Complete-ARN import => GetSecretValue on the exact ...-TLAetA ARN, no partial-ARN footgun.
    metaCapiSecret.grantRead(handler);
    handler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'], // SES SendEmail is identity-scoped; '*' is the conventional resource for send
    }));

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
        'cognito-idp:AdminResetUserPassword',
        'cognito-idp:AdminSetUserMFAPreference',
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
        // PUT is required by the letter-editor "Save new version" (api/letter.ts apiPut → backend
        // router.put /cases/:id/letter). It was missing here AND from the proxy route methods below, so
        // the browser preflight blocked every manual letter save ("Network Error"). (2026-06-06.)
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.PUT, apigwv2.CorsHttpMethod.PATCH, apigwv2.CorsHttpMethod.DELETE, apigwv2.CorsHttpMethod.OPTIONS],
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
        apigwv2.HttpMethod.PUT, // letter-editor save (router.put /cases/:id/letter) — was unroutable
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

    // Jotform webhook (/api/v1/jotform/webhook/:secret) is PUBLIC + secret-gated IN-APP (the secret
    // path segment is validated in createJotformWebhookRouter). It MUST bypass the Cognito JWT
    // authorizer or Jotform's POST gets a gateway 401 ({"message":"Unauthorized"}). More-specific
    // route wins over /api/v1/{proxy+}. (2026-06-04 — found the webhook 401ing at the gateway.)
    httpApi.addRoutes({
      path: '/api/v1/jotform/webhook/{proxy+}',
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('JotformWebhookIntegration', handler),
      // no authorizer — secret auth enforced in-app
    });

    // Stripe webhook (PUBLIC — Stripe SIGNATURE is the auth, verified in-app) + the password-protected
    // delivery portal (PUBLIC — token + emailed password are the auth). Both bypass the Cognito
    // authorizer; more-specific routes win over /api/v1/{proxy+}. (Ryan 2026-06-06.)
    httpApi.addRoutes({
      path: '/api/v1/stripe/webhook',
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('StripeWebhookIntegration', handler),
      // no authorizer — Stripe signature enforced in-app (verifyStripeSignature)
    });
    httpApi.addRoutes({
      path: '/api/v1/delivery/{proxy+}',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('DeliveryPortalIntegration', handler),
      // no authorizer — token + password enforced in-app
    });

    // ===== chart_build_stalled metric-filter alarm (hash-drift "extracting" wedge, 2026-06-26) =====
    // chart-readiness.ts logs `[chart_build_stalled] case <id> is 'extracting' with NO run matching
    // current hash ...` (PLAIN-TEXT console.warn — NOT JSON) on every readiness poll while a case is
    // wedged on the extracting dead-end (Dick/Mittge class). The stuck-RUN watcher is blind to this
    // (it only sees runs that EXIST). Plain-text quoted-term filter mirrors the live drafter
    // `"FATAL (exit 4)"` filter. Reliability/ops signal → ops-alerts (confirmed gmail subscriber).
    const opsTopic = sns.Topic.fromTopicArn(
      this, 'OpsAlertsTopicRef',
      `arn:aws:sns:${this.region}:${this.account}:compact-emr-${props.config.envName}-ops-alerts`,
    );
    const chartBuildStalledFilter = new logs.MetricFilter(this, 'ChartBuildStalledFilter', {
      logGroup: apiLogGroup,
      metricNamespace: `compact-emr-${props.config.envName}`,
      metricName: 'ChartBuildStalled',
      filterPattern: logs.FilterPattern.literal('"[chart_build_stalled]"'),
      metricValue: '1',
      defaultValue: 0,
    });
    const chartBuildStalledAlarm = new cloudwatch.Alarm(this, 'ChartBuildStalledAlarm', {
      alarmName: `compact-emr-${props.config.envName}-chart-build-stalled`,
      alarmDescription:
        'A case is wedged on the chart-extract "extracting" dead-end (hash-drift): chart-readiness ' +
        'logged [chart_build_stalled] with no extraction run matching the current doc-set hash. The ' +
        'route auto-enqueues a self-heal extraction; if this stays in ALARM the self-heal is not ' +
        `converging. Inspect /aws/lambda/compact-emr-${props.config.envName}-api for the caseId.`,
      metric: chartBuildStalledFilter.metric({ statistic: 'Sum', period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    chartBuildStalledAlarm.addAlarmAction(new cloudwatchActions.SnsAction(opsTopic));

    // ===== chart-extract runaway-spend alarms (the $146/68-run incident, 2026-07-14) =====
    // 68 duplicate PAID extractions ran in 18h with the DLQ empty and zero alarms — the per-file
    // assign-loop detonation (INCIDENTS.md 2026-07-14). Two layers, both from the API log group
    // (maybeEnqueueChartExtract runs in this Lambda for every producer):
    // (a) BUDGET REFUSED — the hard per-case cap in chart-extract-trigger.ts refused a non-forced
    //     enqueue past 6 runs/case/hour. ANY occurrence = an active runaway producer being contained;
    //     page immediately so the producer bug gets fixed, not just contained.
    const budgetRefusedFilter = new logs.MetricFilter(this, 'ChartExtractBudgetRefusedFilter', {
      logGroup: apiLogGroup,
      metricNamespace: `compact-emr-${props.config.envName}`,
      metricName: 'ChartExtractBudgetRefused',
      filterPattern: logs.FilterPattern.literal('{ $.event = "chart_extract_budget_refused" }'),
      metricValue: '1',
      defaultValue: 0,
    });
    const budgetRefusedAlarm = new cloudwatch.Alarm(this, 'ChartExtractBudgetRefusedAlarm', {
      alarmName: `compact-emr-${props.config.envName}-chart-extract-budget-refused`,
      alarmDescription:
        'ACTION NEEDED — a case hit the hard chart-extraction budget (6 runs/hour) and further paid ' +
        'runs were REFUSED. The spend is contained, but something is re-triggering extraction in a ' +
        'loop (the class that burned $146 on 2026-07-14). Find the caseId in the ' +
        `chart_extract_budget_refused line in /aws/lambda/compact-emr-${props.config.envName}-api and ` +
        'fix the producer; a deliberate re-extract past the cap still works via force-extract.',
      metric: budgetRefusedFilter.metric({ statistic: 'Sum', period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    budgetRefusedAlarm.addAlarmAction(new cloudwatchActions.SnsAction(opsTopic));
    // (b) ENQUEUE RATE — coarse account-wide backstop for runaway shapes the per-case budget can't
    //     see (many cases at once). Normal volume is a handful of enqueues/hour; 15+/hr ≈ the 7/14
    //     flood's shape. chart_extract_enqueued is logged on EVERY successful enqueue (loud-success
    //     line added in the same incident).
    const extractEnqueuedFilter = new logs.MetricFilter(this, 'ChartExtractEnqueuedFilter', {
      logGroup: apiLogGroup,
      metricNamespace: `compact-emr-${props.config.envName}`,
      metricName: 'ChartExtractEnqueued',
      filterPattern: logs.FilterPattern.literal('{ $.event = "chart_extract_enqueued" }'),
      metricValue: '1',
      defaultValue: 0,
    });
    const extractRateAlarm = new cloudwatch.Alarm(this, 'ChartExtractEnqueueRateAlarm', {
      alarmName: `compact-emr-${props.config.envName}-chart-extract-enqueue-rate`,
      alarmDescription:
        'ACTION NEEDED — 15+ paid chart extractions were enqueued in one hour (normal is a handful). ' +
        'Either a genuinely heavy intake hour or a runaway producer across multiple cases (the 7/14 ' +
        '$146 class). Check per-case counts of chart_extract_enqueued in ' +
        `/aws/lambda/compact-emr-${props.config.envName}-api before assuming it is load.`,
      metric: extractEnqueuedFilter.metric({ statistic: 'Sum', period: Duration.hours(1) }),
      threshold: 15,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    extractRateAlarm.addAlarmAction(new cloudwatchActions.SnsAction(opsTopic));

    // ===== API-Lambda THROTTLES alarm (drafter scaling hardening 2026-06-29) =====
    // This one Lambda is the callback SINK for every drafter task: the Fargate worker POSTs job
    // lifecycle callbacks (/internal/drafter/jobs/:id/{progress,complete,halt}) here. Raising the drafter
    // concurrency cap fans MANY tasks' callbacks at this single function; if its reserved/account
    // concurrency (L-B99A9384) is exhausted, AWS THROTTLES the invokes and a /complete callback is
    // silently dropped — the draft finishes in the container but the EMR never advances the job (the
    // "progress counter disappeared" failure class). Any throttle at all is abnormal here → page on Sum>0.
    const apiThrottlesAlarm = new cloudwatch.Alarm(this, 'ApiLambdaThrottlesAlarm', {
      alarmName: `compact-emr-${props.config.envName}-api-lambda-throttles`,
      alarmDescription:
        'The API Lambda (HTTP API nypr790pq7 + the drafter callback sink) was THROTTLED — account/' +
        'reserved Lambda concurrency (L-B99A9384) is exhausted. Drafter /complete + /progress callbacks ' +
        'can be silently dropped, leaving jobs stuck "drafting" in the EMR while the container already ' +
        'finished. Raise the concurrency limit / add reserved concurrency. Inspect ' +
        `/aws/lambda/compact-emr-${props.config.envName}-api.`,
      metric: handler.metricThrottles({ statistic: 'Sum', period: Duration.minutes(5) }),
      threshold: 0,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    apiThrottlesAlarm.addAlarmAction(new cloudwatchActions.SnsAction(opsTopic));

    // ===== API-Gateway 5xx alarm (silent server-error catch, 2026-06-30) =====
    // The HTTP API itself had NO server-error alarm: a 5xx (broken deploy, DB-connection
    // exhaustion, a downstream 503 like the Ask-Aegis gateway timeout, or an unhandled API-Lambda
    // 502/504) failed SILENTLY — nobody was paged. metricServerError() is the CDK-native handle on
    // this API's server-error metric; CloudWatch publishes it as namespace AWS/ApiGateway, metric
    // "5xx", dimension ApiId=<this api> (nypr790pq7) — NOT AWS/ApiGatewayV2 + ApiName (that's REST
    // v1; verified live this account: the V2 namespace is empty, HTTP-API metrics live under
    // AWS/ApiGateway with ApiId). The metric uses the live CDK ref so it always tracks the real
    // ApiId even if the API is ever replaced. Threshold = >=5 server errors in a single 5-min
    // window: low-traffic staging sees ~0 5xx when healthy, so one transient 5xx (a cold-start
    // blip, a single downstream hiccup) will NOT flap the alarm, but a real outage bursts well past
    // 5 within one window and pages within ~5 min. Unhandled API-Lambda errors are COVERED here —
    // the handler is invoked ONLY as this API's proxy integration (incl. the drafter /internal
    // callbacks), so a throw surfaces as a 502 and a >30s timeout as a 504, both counted in 5xx; a
    // separate Lambda Errors alarm would only double-page the same incident.
    const api5xxAlarm = new cloudwatch.Alarm(this, 'Api5xxAlarm', {
      alarmName: `compact-emr-${props.config.envName}-api-5xx`,
      alarmDescription:
        'The HTTP API (nypr790pq7 / compact-emr-' + props.config.envName + ') returned >=5 server ' +
        '5xx responses in a 5-min window — a server-side outage (broken deploy, DB-connection ' +
        'exhaustion, a downstream 503, or an unhandled API-Lambda 502/504) is failing requests ' +
        'silently. This is the alarm the Ask-Aegis 503 should have tripped. Inspect ' +
        `/aws/lambda/compact-emr-${props.config.envName}-api and recent deploys.`,
      metric: httpApi.metricServerError({ statistic: 'Sum', period: Duration.minutes(5) }),
      threshold: 5,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    api5xxAlarm.addAlarmAction(new cloudwatchActions.SnsAction(opsTopic));
  }
}
