import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  aws_ec2 as ec2,
  aws_kms as kms,
  aws_rds as rds,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cloudwatchActions,
  aws_sns as sns,
} from 'aws-cdk-lib';
import type { CompactEmrConfig } from './config.js';

export interface DatabaseStackProps extends StackProps { config: CompactEmrConfig; vpc: ec2.IVpc }

export class DatabaseStack extends Stack {
  public readonly databaseSecurityGroup: ec2.SecurityGroup;
  public readonly database: rds.DatabaseInstance;
  public readonly instance: rds.DatabaseInstance;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    const dbKey = new kms.Key(this, 'DatabaseKey', {
      enableKeyRotation: true,
      alias: `alias/compact-emr-${props.config.envName}-rds`,
    });

    this.databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc: props.vpc,
      description: 'Allows Postgres only from Compact EMR Lambda security group.',
      allowAllOutbound: false,
    });

    this.database = new rds.DatabaseInstance(this, 'Postgres', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16_3 }),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.databaseSecurityGroup],
      credentials: rds.Credentials.fromGeneratedSecret('compact_emr'),
      databaseName: 'compact_emr',
      allocatedStorage: 100,
      maxAllocatedStorage: 500,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM),
      storageEncrypted: true,
      storageEncryptionKey: dbKey,
      deletionProtection: props.config.deletionProtection,
      backupRetention: Duration.days(35),
      removalPolicy: props.config.envName === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      cloudwatchLogsExports: ['postgresql'],
    });

    this.instance = this.database;

    // ===== RDS CONNECTION-PRESSURE alarm (drafter scaling hardening 2026-06-29) =====
    // db.t4g.medium → Postgres max_connections ≈ 410. Raising the drafter concurrency cap multiplies the
    // pooled connections opened across concurrent drafter tasks + the API Lambda's callback handlers; if
    // they collectively approach max_connections, NEW connections are refused and drafts/API calls fail
    // with "too many clients" — a silent, load-correlated outage. Page at Maximum > 250 (≈60% of ~410)
    // sustained two periods so there is headroom to react before exhaustion. metricDatabaseConnections()
    // auto-dimensions by this instance's DBInstanceIdentifier (AWS/RDS namespace). Reliability signal →
    // ops-alerts (same topic the ~30 existing alarms use; referenced by ARN, no cross-stack export).
    const opsTopic = sns.Topic.fromTopicArn(
      this, 'OpsAlertsTopicRef',
      `arn:aws:sns:${this.region}:${this.account}:compact-emr-${props.config.envName}-ops-alerts`,
    );
    const dbConnectionsAlarm = new cloudwatch.Alarm(this, 'DatabaseConnectionsHighAlarm', {
      alarmName: `compact-emr-${props.config.envName}-rds-connections-high`,
      alarmDescription:
        'RDS DatabaseConnections stayed above 250 (≈60% of the db.t4g.medium ~410 max_connections) for ' +
        '10 min. Concurrent drafter tasks + the API Lambda callback pool are nearing connection ' +
        'exhaustion; past max_connections, new connections are refused ("too many clients") and drafts/' +
        'API calls fail. Pin/lower per-client connection_limit or scale the instance before it tops out.',
      metric: this.database.metricDatabaseConnections({ statistic: 'Maximum', period: Duration.minutes(5) }),
      threshold: 250,
      evaluationPeriods: 2, // 2 × 5min = 10 min sustained
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    dbConnectionsAlarm.addAlarmAction(new cloudwatchActions.SnsAction(opsTopic));
  }
}
