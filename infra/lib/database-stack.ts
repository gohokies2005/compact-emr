import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { aws_ec2 as ec2, aws_kms as kms, aws_rds as rds } from 'aws-cdk-lib';
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
  }
}
