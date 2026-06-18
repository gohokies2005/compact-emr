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
      },
      secrets: {
        // The wrapper reads these from env at startup; AWS injects the actual secret values
        // via the task role's grantRead on each Secret.
        DRAFTER_INVOKE_TOKEN: ecs.Secret.fromSecretsManager(drafterInvokeTokenSecret),
        ANTHROPIC_API_KEY: ecs.Secret.fromSecretsManager(anthropicKeySecret),
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
      threshold: 12, // ~$180 of concurrent drafting sustained — well above normal RN use
      evaluationPeriods: 3, // 3 × 5min = 15 min sustained
      datapointsToAlarm: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    drafterSpendAlarm.addAlarmAction(new cloudwatchActions.SnsAction(costRunawayTopic));

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
