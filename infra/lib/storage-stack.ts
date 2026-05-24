import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { aws_kms as kms, aws_s3 as s3 } from 'aws-cdk-lib';
import type { CompactEmrConfig } from './config.js';

export interface StorageStackProps extends StackProps { config: CompactEmrConfig }

export class StorageStack extends Stack {
  public readonly phiBucket: s3.Bucket;
  public readonly documentsKey: kms.Key;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);

    this.documentsKey = new kms.Key(this, 'PhiBucketKey', {
      enableKeyRotation: true,
      alias: `alias/compact-emr-${props.config.envName}-s3`,
    });

    this.phiBucket = new s3.Bucket(this, 'PhiBucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.documentsKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      // Per HIPAA + AWS BAA: PHI buckets are never auto-deleted by stack destroy.
      // Use a documented quarterly purge script with CloudTrail logging.
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ transitions: [{ storageClass: s3.StorageClass.GLACIER, transitionAfter: Duration.days(730) }] }],
    });
  }
}
