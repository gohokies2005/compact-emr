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
} from 'aws-cdk-lib';
import type { CompactEmrConfig } from './config.js';

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
  documentsKey: kms.IKey;
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

    const handler = new nodejs.NodejsFunction(this, 'PlaceholderApiLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.resolve(__dirname, '../../backend/src/placeholder-lambda.ts'),
      handler: 'handler',
      timeout: Duration.seconds(29), // HttpApi caps at 30s; leave 1s headroom.
      memorySize: 512,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [fnSg],
      logGroup: apiLogGroup,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        ENV_NAME: props.config.envName,
        PHI_BUCKET_NAME: props.phiBucket.bucketName,
        DRAFT_QUEUE_URL: props.draftQueue.queueUrl,
        COGNITO_ISSUER: `https://cognito-idp.${Stack.of(this).region}.amazonaws.com/${props.userPool.userPoolId}`,
        COGNITO_CLIENT_ID: props.userPoolClient.userPoolClientId,
        DATABASE_URL: databaseUrl,
        DATABASE_URL_SECRET_ARN: props.databaseSecret.secretArn,
      },
    });

    props.phiBucket.grantReadWrite(handler);
    props.documentsKey.grantEncryptDecrypt(handler);
    props.databaseSecret.grantRead(handler);
    props.draftQueue.grantSendMessages(handler);


    const migrationProject = new codebuild.Project(this, 'PrismaMigrateDeployProject', {
      projectName: `compact-emr-${props.config.envName}-prisma-migrate-deploy`,
      vpc: props.vpc,
      subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [fnSg],
      source: codebuild.Source.gitHub({
        owner: 'gohokies2005',
        repo: 'compact-emr',
        cloneDepth: 1,
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
            'runtime-versions': { nodejs: '20' },
            commands: ['npm ci'],
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
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.PATCH, apigwv2.CorsHttpMethod.DELETE, apigwv2.CorsHttpMethod.OPTIONS],
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
  }
}
