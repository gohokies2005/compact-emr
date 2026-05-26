import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
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
} from 'aws-cdk-lib';
import type { CompactEmrConfig } from './config.js';

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
 *   2. operator fills DRAFTER_ANTHROPIC_API_KEY secret value via AWS Console
 *   3. drafter window: docker build + docker push to the ECR repo URI (CFN output)
 *   4. update task def imageTag in this file + redeploy + bump desiredCount
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
      description: 'Drafter Fargate task — outbound 443 only (Anthropic + AWS APIs).',
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
      memoryLimitMiB: 8192, // 8 GB
      executionRole,
      taskRole,
      ephemeralStorageGiB: 30, // S3-materialize-to-/tmp per Ryan's answer #2
    });

    // Placeholder image. The drafter wrapper window builds and pushes the real image to
    // ecrRepository. Until then we use a trivial busybox-equivalent so CFN can synthesize
    // a valid task def. Service desiredCount stays at 0 until the operator updates this.
    // Switch this line to `ecs.ContainerImage.fromEcrRepository(ecrRepository, '<git sha>')`
    // after first docker push.
    taskDefinition.addContainer('drafter', {
      // First-deploy placeholder. Replace after the drafter wrapper image is pushed:
      //   image: ecs.ContainerImage.fromEcrRepository(ecrRepository, '<tag>'),
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/busybox:latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'drafter',
        logGroup,
      }),
      environment: {
        ENV_NAME: config.envName,
        COMPACT_EMR_API_URL: `https://${config.apiDomainName}`,
        DRAFT_JOB_QUEUE_URL: draftJobQueue.queueUrl,
        DRAFTER_ARTIFACTS_S3_BUCKET: phiBucket.bucketName,
        DRAFTER_ARTIFACTS_S3_PREFIX: 'drafter-artifacts/',
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
    // Desired count = 0 on first deploy. Operator bumps to 1 after pushing the real image.
    // Scaling: not auto-scaled yet — start with 1 task, add queue-depth-based scaling later
    // once we have throughput data.
    const service = new ecs.FargateService(this, 'DrafterService', {
      serviceName: `compact-emr-${config.envName}-drafter`,
      cluster,
      taskDefinition,
      desiredCount: 0,
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
  }
}
