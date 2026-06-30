import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_ecs as ecs,
  aws_iam as iam,
  aws_kms as kms,
  aws_logs as logs,
  aws_s3 as s3,
  aws_secretsmanager as secretsmanager,
  aws_sqs as sqs,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cloudwatchActions,
  aws_sns as sns,
  aws_applicationautoscaling as appscaling,
  aws_events as events,
  aws_events_targets as targets,
} from 'aws-cdk-lib';
import type { CompactEmrConfig } from './config.js';
import { DRAFTER_MAX_CONCURRENCY } from './drafter-constants.js';

export interface DrafterStackProps extends StackProps {
  config: CompactEmrConfig;
  vpc: ec2.IVpc;
  draftJobQueue: sqs.IQueue;
  drafterInvokeTokenSecret: secretsmanager.ISecret;
  phiBucket: s3.IBucket;
  doctorPacksBucket: s3.IBucket;
  documentsKey: kms.IKey;
}

/**
 * Drafter Fargate stack (wrap-don't-rewrite).
 *
 * The FRN nexus-letter drafter is a Node pipeline that runs 15-20 min per case — past
 * Lambda's 15-min ceiling. So it runs as a persistent Fargate ECS service in a private
 * subnet with NAT egress (Anthropic API + AWS APIs), consuming jobs from DraftJobQueue.
 *
 * Compact-EMR stays TypeScript; the drafter stays the existing Node code; they talk via
 * the thin contract in `routes/drafter.ts`:
 *   - dequeue job from SQS
 *   - GET /api/v1/cases/:id/drafter-export                                  (Cognito)
 *   - POST /api/v1/internal/drafter/jobs/:id/progress  every phase          (drafter token)
 *   - POST /api/v1/internal/drafter/jobs/:id/complete  at terminal          (drafter token)
 *
 * THIS STACK IS A SCAFFOLD. It creates the ECR repo + cluster + task def + service + IAM
 * role + log group. It does NOT contain the Docker image — the drafter window builds and
 * pushes that. Until the first image is pushed and `desiredCount` is bumped from 0 to 1,
 * the service is dormant.
 *
 * Deploy flow:
 *   1. cdk deploy compact-emr-staging-drafter            (scaffold lands; service idle)
 *   2. operator fills compact-emr-${env}/drafter-anthropic-api-key secret value via AWS Console
 *   3. drafter window: docker build + docker push to the ECR repo URI (CFN output)
 *   4. set env var DRAFTER_IMAGE_TAG=<git-sha> (or cdk.context.json) + bump desiredCount + redeploy
 *   5. Fargate task starts pulling from DraftJobQueue
 */
export class DrafterStack extends Stack {
  public readonly ecrRepository: ecr.IRepository;
  public readonly cluster: ecs.ICluster;
  public readonly service: ecs.FargateService;
  public readonly taskRole: iam.IRole;
  public readonly anthropicKeySecret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: DrafterStackProps) {
    super(scope, id, props);
    const { config, vpc, draftJobQueue, drafterInvokeTokenSecret, phiBucket, doctorPacksBucket, documentsKey } = props;

    // ===== ECR repo for the drafter image =====
    // Image tag convention: drafter:<git sha>. The drafter wrapper repo (separate window)
    // builds + pushes here; this stack only consumes the latest pushed tag.
    const ecrRepository = new ecr.Repository(this, 'DrafterImageRepo', {
      repositoryName: `compact-emr-${config.envName}-drafter`,
      imageTagMutability: ecr.TagMutability.MUTABLE,
      lifecycleRules: [
        { description: 'keep last 20 images', maxImageCount: 20 },
      ],
      removalPolicy: config.envName === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    this.ecrRepository = ecrRepository;

    // ===== Anthropic API key secret (separate from FRN-main's app/.env) =====
    // The Anthropic key is provisioned here but the VALUE is left empty in CFN. Operator
    // fills it via AWS Console (Secrets Manager → set secret value) after first deploy.
    // Reason: do not bake the API key into the CFN template that ends up in CloudTrail.
    const anthropicKeySecret = new secretsmanager.Secret(this, 'DrafterAnthropicKey', {
      secretName: `compact-emr-${config.envName}/drafter-anthropic-api-key`,
      description: 'Anthropic API key for the compact-EMR drafter. Operator fills the value in the AWS Console.',
      // No generateSecretString — leave empty so operator pastes the real key.
    });
    this.anthropicKeySecret = anthropicKeySecret;

    // ===== NCBI E-utilities API key (post-draft §VIII citation backfill) =====
    // PRE-EXISTING secret created out-of-band (NOT CDK-owned): friendly name 'frn/ncbi-api-key',
    // full ARN ...-c8E88t. The post-draft citation backfill (run-letter-pipeline.js §VIII safety
    // net → citationFallback.js) reads process.env.NCBI_API_KEY PER-REQUEST; the key raises the
    // NCBI rate limit 3/s -> 10/s + improves reliability (keyless still works, so this is a
    // reliability/speed upgrade, not a correctness dependency).
    // Import by the FULL COMPLETE ARN (fromSecretCompleteArn) — NOT fromSecretNameV2: the latter
    // emits a PARTIAL ARN ('frn/ncbi-api-key' without the -c8E88t suffix) that resolves as a
    // SecretId Secrets Manager can't find → masquerades as AccessDenied (the partial-ARN footgun,
    // INCIDENTS 2026-06-05). fromSecretCompleteArn pins the exact resource so grantRead writes an
    // IAM policy on the real ARN and the ecs.Secret.fromSecretsManager injection resolves cleanly.
    const ncbiApiKeySecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'NcbiApiKeySecret',
      'arn:aws:secretsmanager:us-east-1:676591241787:secret:frn/ncbi-api-key-c8E88t',
    );

    // ===== ECS cluster =====
    const cluster = new ecs.Cluster(this, 'DrafterCluster', {
      clusterName: `compact-emr-${config.envName}-drafter`,
      vpc,
      enableFargateCapacityProviders: true,
    });
    this.cluster = cluster;

    // ===== Log group =====
    const logGroup = new logs.LogGroup(this, 'DrafterLogGroup', {
      logGroupName: `/aws/ecs/compact-emr-${config.envName}-drafter`,
      retention: logs.RetentionDays.SIX_MONTHS,
      removalPolicy: config.envName === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // ===== Task IAM roles =====
    // Execution role: pulls image from ECR, writes logs to CloudWatch.
    const executionRole = new iam.Role(this, 'DrafterExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')],
    });
    // Task role: what the drafter wrapper actually does at runtime.
    const taskRole = new iam.Role(this, 'DrafterTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Runtime role for the drafter Fargate task. SQS receive, S3 read/write under drafter-artifacts/, Secrets read.',
    });
    this.taskRole = taskRole;

    draftJobQueue.grantConsumeMessages(taskRole);
    phiBucket.grantRead(taskRole);
    // Drafter writes the final v<N>.{pdf,txt,docx} under drafter-artifacts/ prefix in the
    // PHI bucket. The complete endpoint stores the s3Key in DraftJob.artifactPdfS3Key etc.
    phiBucket.grantPut(taskRole, 'drafter-artifacts/*');
    doctorPacksBucket.grantRead(taskRole);
    documentsKey.grantEncryptDecrypt(taskRole);
    drafterInvokeTokenSecret.grantRead(taskRole);
    anthropicKeySecret.grantRead(taskRole);
    // NCBI key: task role reads it at runtime (injected as the NCBI_API_KEY env var via the
    // secrets: block below). grantRead on the COMPLETE-ARN-imported secret writes the
    // secretsmanager:GetSecretValue policy on the exact ...-c8E88t ARN.
    ncbiApiKeySecret.grantRead(taskRole);
    // Task scale-in PROTECTION (2026-06-18): the worker self-protects via the agent endpoint
    // ($ECS_AGENT_URI/task-protection/v1/state) so the autoscaler can't reap a still-drafting task (the
    // ">1 draft dies" root cause). The agent endpoint authorizes with the TASK ROLE — without these
    // grants it returns AccessDenied and the worker's fail-open helper SILENTLY no-ops (the fix would
    // look deployed but do nothing — AWS ECS docs: "IAM permissions required for task scale-in
    // protection"). Scoped to this drafter cluster's tasks.
    taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ecs:UpdateTaskProtection', 'ecs:GetTaskProtection'],
      resources: [`arn:aws:ecs:${this.region}:${this.account}:task/compact-emr-${config.envName}-drafter/*`],
    }));

    // ===== Security group: outbound 443 only =====
    const securityGroup = new ec2.SecurityGroup(this, 'DrafterSecurityGroup', {
      vpc,
      allowAllOutbound: false,
      description: 'Drafter Fargate task - outbound 443 only (Anthropic + AWS APIs).',
    });
    securityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS egress to Anthropic and AWS service endpoints');

    // ===== Task definition =====
    // Sizing rationale: drafter runs ~15-20 min wall-clock with ~6-9 LLM round-trips. RAM
    // budget covers the references library (~50 MB), case data, and a few hundred MB for
    // V8 + Anthropic SDK chatter. CPU bursts during PDF render are the peak.
    //   4 vCPU / 8 GB is the sweet spot; bump to 8 vCPU / 16 GB if PDF render is slow.
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'DrafterTaskDef', {
      family: `compact-emr-${config.envName}-drafter`,
      cpu: 4096, // 4 vCPU
      memoryLimitMiB: 16384, // 16 GB (bumped from 8 GB 2026-06-08: OOM hedge for the memory-heavy post-v1 QA phase; 4 vCPU supports 8-30 GB)
      executionRole,
      taskRole,
      ephemeralStorageGiB: 30, // S3-materialize-to-/tmp per Ryan's answer #2
    });

    // Architect QA F5: parameterize the image tag so deploys don't require a source edit.
    // Resolution order:
    //   1. Env var DRAFTER_IMAGE_TAG          (operator one-shot override)
    //   2. CDK context  drafter_image_tag     (cdk.context.json / --context)
    //   3. fallback to 'placeholder'          (first deploy before any docker push)
    // When the tag is 'placeholder' (or empty), use a public busybox image so CFN can
    // synthesize a valid task def before the drafter window's first push. desiredCount stays
    // at 0 — nothing actually tries to pull the placeholder. After first push the operator
    // runs (or sets cdk.context.json to):
    //   $env:DRAFTER_IMAGE_TAG = '<git-sha>'
    //   npx cdk deploy compact-emr-staging-drafter --context env=staging
    // No source edit needed.
    const imageTag = process.env['DRAFTER_IMAGE_TAG']
      ?? (this.node.tryGetContext('drafter_image_tag') as string | undefined)
      ?? 'placeholder';
    const isPlaceholder = imageTag === 'placeholder' || imageTag.length === 0;
    const drafterImage = isPlaceholder
      ? ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/busybox:latest')
      : ecs.ContainerImage.fromEcrRepository(ecrRepository, imageTag);

    taskDefinition.addContainer('drafter', {
      image: drafterImage,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'drafter',
        logGroup,
      }),
      environment: {
        ENV_NAME: config.envName,
        // api.emr.flatratenexus.com custom domain is NOT set up yet (NXDOMAIN) — the worker must
        // reach the raw API Gateway endpoint or every /progress + /complete callback fails DNS.
        // TODO: wire ApiStack.httpApi.apiEndpoint as a prop (or stand up the api custom domain),
        // then revert to `https://${config.apiDomainName}`.
        COMPACT_EMR_API_URL: 'https://nypr790pq7.execute-api.us-east-1.amazonaws.com',
        DRAFT_JOB_QUEUE_URL: draftJobQueue.queueUrl,
        DRAFTER_ARTIFACTS_S3_BUCKET: phiBucket.bucketName,
        DRAFTER_ARTIFACTS_S3_PREFIX: 'drafter-artifacts/',
        // Gate 2 (pre-draft dx/event verification) ON — drafter-worker reads `=== 'true'` exactly.
        // The EMR side (/halt receiver + Gate-1 modal + needs_rn_decision panel + chart override log)
        // is built, architect-QA'd (SHIP-WITH-FIXES, fixes applied), and live. Fail-to-halt: a no-dx
        // case parks for the RN, never mis-drafts. Activated 2026-06-06 per the drafter33 bundle.
        // Revert: set to 'false' + redeploy.
        DRAFTER_GATE2_ENABLED: 'true',
        // ANCHOR_MECHANISM_GATE (Ryan 2026-06-15): mechanism-table-driven anchor ranking for LIVE
        // letters — drops M0 sympathetic anchors (tinnitus→OSA …), mechanism dominates the ranking,
        // and ACTIVATES the framingGate tier-floor guardrail (never reach to a lower secondary tier;
        // the LLM may still choose within the top tier). Complements the DOMINANT-THEORY DISCIPLINE
        // (claude.js) prompt rule. Validated: Flynn-guard 9/9 + tier-floor 8/8 (incl. denied-set F1).
        // Reverts to byte-identical pre-gate ranking by removing this line + redeploy (drafter idle).
        ANCHOR_MECHANISM_GATE: 'true',
        // AI_ROUTE_PICKER_ENABLED (Ryan 2026-06-19): the LLM route-picker brain selects the
        // anchor/theory pathway in the drafter. Baked into CDK so a normal `cdk deploy --all`
        // STOPS reverting it — previously this flag lived ONLY on a hand-registered task-def
        // revision (rev 54, image 72cb144-routepicker) and the next CDK converge would have
        // dropped it. The SAME flag is also baked into the API Lambda (api-stack.ts) so the
        // Overview viability CARD's deriveAiViability runs the picker too. Revert (CDK-permanent):
        // set to 'false' (or remove) + redeploy the drafter while the SQS queue is idle.
        // Emergency revert without a deploy: register a task-def revision with the flag flipped
        // and update the service — the next CDK deploy reconverges to this value.
        AI_ROUTE_PICKER_ENABLED: 'true',
      },
      secrets: {
        // The wrapper reads these from env at startup; AWS injects the actual secret values
        // via the task role's grantRead on each Secret.
        DRAFTER_INVOKE_TOKEN: ecs.Secret.fromSecretsManager(drafterInvokeTokenSecret),
        ANTHROPIC_API_KEY: ecs.Secret.fromSecretsManager(anthropicKeySecret),
        // NCBI E-utilities key for the post-draft §VIII citation backfill (raises NCBI rate
        // 3/s -> 10/s). The worker reads process.env.NCBI_API_KEY per-request; keyless still
        // works, so an empty/absent secret value degrades gracefully (no crash). This injects
        // the secret value into the task env at task START (not baked into the task-def JSON).
        NCBI_API_KEY: ecs.Secret.fromSecretsManager(ncbiApiKeySecret),
      },
      essential: true,
    });

    // ===== Fargate service =====
    // DO NOT bump desiredCount above 0 until a REAL drafter image (not the busybox
    // placeholder) is pushed to ECR AND referenced via DRAFTER_IMAGE_TAG / cdk context.
    // The placeholder busybox image is pullable but has no entrypoint matching the wrapper
    // contract — bumping desiredCount with placeholder == crash-loop until manually stopped.
    // Scaling: not auto-scaled yet — start with 1 task, add queue-depth-based scaling later
    // once we have throughput data.
    const service = new ecs.FargateService(this, 'DrafterService', {
      serviceName: `compact-emr-${config.envName}-drafter`,
      cluster,
      taskDefinition,
      desiredCount: 0, // scale-to-zero: the autoscaler (below) runs 1 task only when the queue has work, 0 when idle (~$0 idle cost).
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [securityGroup],
      // Long-running tasks: when a deploy rolls out a new image, drain in-flight jobs first.
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      enableExecuteCommand: true, // allow `aws ecs execute-command` for in-task debugging
      // Drafter is long-running but stateless w.r.t. SQS; restart on failure is fine.
      circuitBreaker: { rollback: true },
    });
    this.service = service;

    // ===== Queue-depth scale-to-zero (min 0 / max 1) =====
    // Run exactly one worker when there is work, none when idle. The scaling metric is
    // (visible + in-flight) messages so a task is NOT killed mid-job: while the worker holds a
    // message (in-flight / NotVisible) the depth stays >= 1, keeping the task alive until it
    // deletes the message on /complete. Cold start adds ~2-4 min before a queued job is picked up
    // (alarm period + image pull) — fine for the 15-20 min async drafting run.
    // maxCapacity = DRAFTER_MAX_CONCURRENCY: lets a batch of independent drafts (distinct caseId =
    // distinct FIFO group) fan out instead of serializing (2026-06-06). The real-world ceiling is the
    // Fargate On-Demand vCPU quota (L-3032A538) ÷ 4 vCPU/task — at 100 vCPU that's 25 tasks (raised
    // 2026-06-17). The SAME const is injected as DRAFTER_MAX_CONCURRENCY on the API Lambda
    // (api-stack.ts) so the queue-position UI's "drafter is full" threshold can never drift from this
    // ceiling. NEVER hardcode the number in a second place.
    const scaling = service.autoScaleTaskCount({ minCapacity: 0, maxCapacity: DRAFTER_MAX_CONCURRENCY });
    const queueDepth = new cloudwatch.MathExpression({
      expression: 'visible + inflight',
      label: 'DraftJobQueueDepth',
      usingMetrics: {
        // Explicit AWS/SQS metric (dimensioned by queue NAME) — avoids a cross-stack export from
        // the workers stack that draftJobQueue.metric() would create (which breaks a drafter-only
        // --exclusively deploy with "No export named ... found").
        visible: new cloudwatch.Metric({ namespace: 'AWS/SQS', metricName: 'ApproximateNumberOfMessagesVisible', dimensionsMap: { QueueName: `compact-emr-${config.envName}-draft-job.fifo` }, period: Duration.minutes(1), statistic: 'Maximum' }),
        inflight: new cloudwatch.Metric({ namespace: 'AWS/SQS', metricName: 'ApproximateNumberOfMessagesNotVisible', dimensionsMap: { QueueName: `compact-emr-${config.envName}-draft-job.fifo` }, period: Duration.minutes(1), statistic: 'Maximum' }),
      },
      period: Duration.minutes(1),
    });
    scaling.scaleOnMetric('DrafterQueueDepthScaling', {
      metric: queueDepth,
      // EXACT_CAPACITY: `change` is the ABSOLUTE desired task count for that depth band (not a delta).
      // The old [{<=0:0},{>=1:1}] pinned the service to EXACTLY 1 task at ANY depth — so raising
      // maxCapacity did nothing and a batch serialized (2026-06-06). Set tasks = min(depth, 6) so N
      // independent queued drafts get N tasks and run concurrently (each pulls a distinct FIFO group).
      adjustmentType: appscaling.AdjustmentType.EXACT_CAPACITY,
      // DERIVED from DRAFTER_MAX_CONCURRENCY so the step table can NEVER again silently top out below the
      // cap (the old hand-listed table stopped at 6 → bumping the const alone was a no-op past 6).
      // CONSTRAINT: AWS Application Auto Scaling allows at most 20 step adjustments PER POLICY, so one
      // step per depth overflows at cap=25 (this deploy rolled back on exactly that, 2026-06-17). So:
      // 1:1 for the first 17 depth bands, then ONE band that jumps to the full cap (≤18 scale-out steps).
      // depth d in [1,17] -> d tasks; depth >= 18 -> DRAFTER_MAX_CONCURRENCY.
      scalingSteps: [
        { upper: 0, change: 0 }, // no messages -> 0 tasks (scale-to-zero)
        ...Array.from({ length: Math.min(DRAFTER_MAX_CONCURRENCY, 17) }, (_, i) => ({ lower: i + 1, change: i + 1 })),
        ...(DRAFTER_MAX_CONCURRENCY > 17 ? [{ lower: 18, change: DRAFTER_MAX_CONCURRENCY }] : []),
      ],
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      cooldown: Duration.minutes(1),
    });

    // ===== Task-stop forensics: persistently log WHY each drafter task stops =====
    // When a drafter Fargate task STOPS (OOMKilled, deployment-drain, scale-in, crash, etc.),
    // ECS emits an "ECS Task State Change" event whose detail carries stoppedReason, stopCode,
    // containers[].reason, and the task ARN. We capture that full event into a dedicated log
    // group so the NEXT drafter freeze has a definitive recorded cause instead of a guess.
    //
    // Purely additive: a new LogGroup + EventBridge Rule + the rule's CloudWatch-Logs target.
    // It does NOT touch the task definition, service, image, autoscaling, or env — so it cannot
    // replace or restart the running task.
    const taskStopLogGroup = new logs.LogGroup(this, 'DrafterTaskStopLogGroup', {
      logGroupName: `/compact-emr-${config.envName}/drafter-task-stops`,
      retention: logs.RetentionDays.ONE_MONTH,
      // Ephemeral forensic stream — DESTROY in non-prod to match the repo's other transient
      // log groups; RETAIN in prod so the stop history survives a stack teardown.
      removalPolicy: config.envName === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // Match ONLY this drafter cluster's tasks reaching lastStatus STOPPED. Scoping on
    // clusterArn keeps every other ECS task-state-change (other stacks/clusters) out.
    new events.Rule(this, 'DrafterTaskStopRule', {
      ruleName: `compact-emr-${config.envName}-drafter-task-stop`,
      description: 'Capture ECS Task State Change STOPPED events for the drafter cluster (stoppedReason/stopCode forensics).',
      eventPattern: {
        source: ['aws.ecs'],
        detailType: ['ECS Task State Change'],
        detail: {
          clusterArn: [cluster.clusterArn],
          lastStatus: ['STOPPED'],
        },
      },
      // CloudWatchLogGroup target (CDK 2.x) writes the full event JSON and auto-provisions the
      // log-group resource policy granting events.amazonaws.com PutLogEvents.
      targets: [new targets.CloudWatchLogGroup(taskStopLogGroup)],
    });

    // ===== Drafter SPEND-PROXY alarm (cost audit 2026-06-18) =====
    // The drafter is the priciest lane (~$15/run, Sonnet+Opus). Per-case loops are bounded (FIFO
    // MessageGroupId=caseId → 1 in-flight/group; stuck-job rerun cap=1), but there was NO notification
    // when MANY drafts run concurrently across cases (the autoscaler can go to DRAFTER_MAX_CONCURRENCY).
    // ApproximateNumberOfMessagesNotVisible on the FIFO queue ≈ drafts currently being processed ≈ $15
    // each. Alarm when that stays HIGH (sustained 15 min) so Ryan is PAGED on abnormal concurrent spend
    // — wired to the cost-runaway topic he just confirmed. Threshold set well above normal RN use so it
    // flags a runaway/storm, not an intentional batch. (Does NOT cap capacity — that's his scaling goal.)
    const costRunawayTopic = sns.Topic.fromTopicArn(this, 'CostRunawayTopicRef', `arn:aws:sns:${this.region}:${this.account}:compact-emr-${config.envName}-cost-runaway-alerts`);
    const draftsInFlight = new cloudwatch.Metric({
      namespace: 'AWS/SQS',
      metricName: 'ApproximateNumberOfMessagesNotVisible',
      dimensionsMap: { QueueName: `compact-emr-${config.envName}-draft-job.fifo` },
      period: Duration.minutes(5),
      statistic: 'Maximum',
    });
    const drafterSpendAlarm = new cloudwatch.Alarm(this, 'DrafterConcurrentSpendAlarm', {
      alarmName: `compact-emr-${config.envName}-drafter-concurrent-spend`,
      alarmDescription:
        'Drafts in-flight (FIFO NotVisible) stayed high for 15 min — many ~$15 drafter runs are processing at once. Expected during a deliberate batch; if you did NOT start a batch, a re-enqueue storm across cases is burning budget. Check the draft-job.fifo queue + recent DraftJob rows.',
      metric: draftsInFlight,
      threshold: 22, // raised 12→22 when the concurrency cap moved to DRAFTER_MAX_CONCURRENCY=20 (was
      // continuously breaching at 12 once a normal full batch fans out to the cap). 22 = a couple of drafts
      // ABOVE the cap of in-flight runs sustained — a genuine re-enqueue storm, not an intended full batch.
      evaluationPeriods: 3, // 3 × 5min = 15 min sustained
      datapointsToAlarm: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    drafterSpendAlarm.addAlarmAction(new cloudwatchActions.SnsAction(costRunawayTopic));

    // FAIL-LOUD: a draft killed mid-flight by the scheduler (2026-06-18 root cause — autoscaler scale-in
    // reaping a still-drafting task). Task scale-in PROTECTION (worker-side) now prevents this, but if it
    // ever recurs (a drafter-stack deploy WHILE a draft runs, a protection-endpoint failure, etc.) it was
    // SILENT — the EMR just showed a stuck/partial job. The worker logs `{"msg":"SIGTERM received",
    // ...,"hasJob":true}` exactly when a busy task is being torn down; alarm on it so it's never silent
    // again. (A normal scale-in of an IDLE task logs hasJob:false → not matched.)
    const reapedMidDraftMetric = new logs.MetricFilter(this, 'DrafterReapedMidDraftFilter', {
      logGroup,
      metricNamespace: `compact-emr-${config.envName}/drafter`,
      metricName: 'ReapedMidDraft',
      filterPattern: logs.FilterPattern.all(
        logs.FilterPattern.stringValue('$.msg', '=', 'SIGTERM received'),
        logs.FilterPattern.booleanValue('$.hasJob', true),
      ),
      metricValue: '1',
      defaultValue: 0,
    });
    const reapedMidDraftAlarm = new cloudwatch.Alarm(this, 'DrafterReapedMidDraftAlarm', {
      alarmName: `compact-emr-${config.envName}-drafter-reaped-mid-draft`,
      alarmDescription:
        'A drafter task received SIGTERM while it still held a job (hasJob:true) — a draft was killed mid-flight. Task scale-in protection should prevent this; if it fired, either the drafter stack was deployed mid-draft or the protection endpoint failed. Check drafter-task-stops + the worker logs.',
      metric: reapedMidDraftMetric.metric({ period: Duration.minutes(5), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    reapedMidDraftAlarm.addAlarmAction(new cloudwatchActions.SnsAction(costRunawayTopic));

    // ===== Drafter SILENT-FAILURE metric-filter alarms (FRN drafter b2d10e1, 2026-06-26) =====
    // run-letter-pipeline.js runs INSIDE this Fargate container, so its plain-text console.warn lines land
    // in THIS log group. Two previously-silent failure lines, matched with quoted-term filters mirroring
    // the live `"FATAL (exit 4)"` filter. Reliability/ops signals (not cost) → ops-alerts (confirmed sub).
    const opsTopic = sns.Topic.fromTopicArn(
      this, 'OpsAlertsTopicRef',
      `arn:aws:sns:${this.region}:${this.account}:compact-emr-${config.envName}-ops-alerts`,
    );
    // (1) §VIII shipped with 0 numbered citations after backfill+strip (Sanderson nephroptosis class).
    const refsEmptyFilter = new logs.MetricFilter(this, 'DrafterReferencesEmptyFilter', {
      logGroup,
      metricNamespace: `compact-emr-${config.envName}/drafter`,
      metricName: 'ReferencesEmpty',
      filterPattern: logs.FilterPattern.literal('"[references_empty]"'),
      metricValue: '1',
      defaultValue: 0,
    });
    const refsEmptyAlarm = new cloudwatch.Alarm(this, 'DrafterReferencesEmptyAlarm', {
      alarmName: `compact-emr-${config.envName}-drafter-references-empty`,
      alarmDescription:
        'A nexus letter shipped with 0 numbered Section VIII references (grounded NCBI fallback found ' +
        'only off-topic papers and the case-law strip removed the rest). In-app raises a physician ' +
        'advisory and the letter stays editable (no hard fail); a rare/structural condition is not in ' +
        'the citation synonym map. Inspect the drafter logs + the case Section VIII.',
      metric: refsEmptyFilter.metric({ statistic: 'Sum', period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    refsEmptyAlarm.addAlarmAction(new cloudwatchActions.SnsAction(opsTopic));
    // (2) Grounded NCBI fallback retrieved ONLY off-topic papers (status=all_rejected_off_topic).
    const fallbackOffTopicFilter = new logs.MetricFilter(this, 'DrafterFallbackAllRejectedFilter', {
      logGroup,
      metricNamespace: `compact-emr-${config.envName}/drafter`,
      metricName: 'GroundedFallbackAllRejected',
      filterPattern: logs.FilterPattern.literal('"all_rejected_off_topic"'),
      metricValue: '1',
      defaultValue: 0,
    });
    const fallbackOffTopicAlarm = new cloudwatch.Alarm(this, 'DrafterFallbackAllRejectedAlarm', {
      alarmName: `compact-emr-${config.envName}-drafter-grounded-fallback-all-rejected`,
      alarmDescription:
        'The drafter grounded NCBI fallback ran and EVERY retrieved paper scored off-topic ' +
        '(status=all_rejected_off_topic): no library folder AND the synonym map did not steer NCBI to ' +
        'on-topic literature. The letter drafts on chart facts + regulation, flagged for backfill. Add ' +
        'the condition synonyms / a library folder. Inspect the drafter logs.',
      metric: fallbackOffTopicFilter.metric({ statistic: 'Sum', period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    fallbackOffTopicAlarm.addAlarmAction(new cloudwatchActions.SnsAction(opsTopic));

    // ===== Drafter PLACEMENT-STARVATION alarm (FRN_WORKLIST line 81, scaling hardening 2026-06-29) =====
    // The silent failure when raising the concurrency cap: the autoscaler REQUESTS up to
    // min(depth, DRAFTER_MAX_CONCURRENCY) tasks, but a Fargate On-Demand vCPU-quota exhaustion
    // (L-3032A538, 100 vCPU ÷ 4 vCPU/task = 25-task ceiling) leaves the Nth task stuck PENDING. ECS
    // does NOT surface a placement failure as a metric, and Container Insights is OFF on this cluster
    // (no `containerInsights` set on `DrafterCluster`), so the precise `ECS/ContainerInsights`
    // RunningTaskCount<DesiredTaskCount signal is NOT published. The closest FEASIBLE signal off the
    // always-on AWS/SQS metrics: there is queued work that is NOT being absorbed while the running fleet
    // is short of capacity — i.e. ApproximateNumberOfMessagesVisible (un-picked backlog) > 0 AND
    // ApproximateNumberOfMessagesNotVisible (in-flight ≈ tasks holding a message) stays BELOW the cap,
    // SUSTAINED. A healthy saturated batch pins in-flight AT the cap (condition false → quiet); a brief
    // scale-out ramp from 0 clears well inside the 30-min window (not sustained → quiet); only a fleet
    // that cannot reach capacity while work waits for 30 min straight trips it. Reliability/outage signal
    // → ops-alerts (same topic the chart-build/refs-empty/DLQ alarms use). NOTE: enabling Container
    // Insights on DrafterCluster would let this be replaced by the exact RunningTaskCount<DesiredTaskCount
    // alarm — recommended follow-up; this proxy is the no-extra-cost stand-in until then.
    const starvationFloor = DRAFTER_MAX_CONCURRENCY - 1; // in-flight peak this far below cap = fleet short
    const placementStarvationSignal = new cloudwatch.MathExpression({
      expression: `IF(visible > 0 AND inflight < ${starvationFloor}, 1, 0)`,
      label: 'DrafterPlacementStarvation',
      usingMetrics: {
        visible: new cloudwatch.Metric({ namespace: 'AWS/SQS', metricName: 'ApproximateNumberOfMessagesVisible', dimensionsMap: { QueueName: `compact-emr-${config.envName}-draft-job.fifo` }, period: Duration.minutes(5), statistic: 'Maximum' }),
        inflight: new cloudwatch.Metric({ namespace: 'AWS/SQS', metricName: 'ApproximateNumberOfMessagesNotVisible', dimensionsMap: { QueueName: `compact-emr-${config.envName}-draft-job.fifo` }, period: Duration.minutes(5), statistic: 'Maximum' }),
      },
      period: Duration.minutes(5),
    });
    const placementStarvationAlarm = new cloudwatch.Alarm(this, 'DrafterPlacementStarvationAlarm', {
      alarmName: `compact-emr-${config.envName}-drafter-placement-starvation`,
      alarmDescription:
        'Drafts are queued (draft-job.fifo has Visible/un-picked messages) but the running drafter fleet ' +
        `stayed below the concurrency cap (in-flight peak < ${starvationFloor}) for 30 min straight — tasks ` +
        'are not being PLACED. Most likely the Fargate On-Demand vCPU quota (L-3032A538) is exhausted so ' +
        'the next task is stuck PENDING; the EMR just shows drafts sitting "in line". Check the ECS service ' +
        'events (compact-emr-' + config.envName + '-drafter) for "unable to place a task because no ' +
        'container instance / RESOURCE:VCPU" and the Service Quotas console.',
      metric: placementStarvationSignal,
      threshold: 1,
      evaluationPeriods: 6, // 6 × 5min = 30 min sustained
      datapointsToAlarm: 6,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    placementStarvationAlarm.addAlarmAction(new cloudwatchActions.SnsAction(opsTopic));

    // ===== Outputs the drafter window needs =====
    // ECR repo URI — drafter window runs `docker push <uri>:<git-sha>` against this.
    new CfnOutput(this, 'DrafterImageRepoUri', {
      value: ecrRepository.repositoryUri,
      description: 'ECR repository URI for drafter image. Tag and push: docker push <this>:<sha>',
      exportName: `compact-emr-${config.envName}-drafter-image-repo-uri`,
    });
    // Resolved image tag — operator can confirm at-a-glance whether the deploy used the
    // placeholder or a real sha. Lights up "placeholder" until first real DRAFTER_IMAGE_TAG.
    new CfnOutput(this, 'DrafterResolvedImageTag', {
      value: imageTag,
      description: 'Image tag currently referenced by the task definition. "placeholder" = busybox.',
      exportName: `compact-emr-${config.envName}-drafter-resolved-image-tag`,
    });
  }
}
