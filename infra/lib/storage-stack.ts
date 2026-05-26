import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { aws_kms as kms, aws_s3 as s3 } from 'aws-cdk-lib';
import type { CompactEmrConfig } from './config.js';

export interface StorageStackProps extends StackProps { config: CompactEmrConfig }

export class StorageStack extends Stack {
  public readonly phiBucket: s3.Bucket;
  public readonly doctorPacksBucket: s3.Bucket;
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
      eventBridgeEnabled: true,
      // Per HIPAA + AWS BAA: PHI buckets are never auto-deleted by stack destroy.
      // Use a documented quarterly purge script with CloudTrail logging.
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        // Default: everything moves to Glacier after 2 years (cold archive).
        { id: 'glacier-2y', transitions: [{ storageClass: s3.StorageClass.GLACIER, transitionAfter: Duration.days(730) }] },
        // F1b (Ryan 2026-05-26): drafter-exports/manual-*.json are ad-hoc human-debug exports
        // from GET /drafter-export — no audit value, delete after 14 days. Per-job
        // drafter-exports/<jobId>.json bundles are NOT covered by this rule; they stay
        // indefinitely as audit evidence ("what data did the drafter see when it produced
        // v<N>?") which is medical-legal record per Ryan's retention policy.
        {
          id: 'drafter-manual-exports-14d',
          enabled: true,
          prefix: 'drafter-exports/',
          // S3 lifecycle prefix matching is glob-free; we use a tag-based filter instead so
          // only manual exports get the short expiry. The drafter-bundle service tags manual
          // uploads with bundle-kind=manual; per-job uploads get bundle-kind=job (no expiry).
          tagFilters: { 'bundle-kind': 'manual' },
          expiration: Duration.days(14),
          // Architect F1b QA: bucket is versioned, so the 14-day current-version expiration
          // creates a delete marker but leaves non-current versions accumulating forever.
          // Reap those alongside the current version so manual exports actually go away.
          noncurrentVersionExpiration: Duration.days(14),
        },
      ],
    });

    // Phase 7B Doctor Pack output bucket. Same KMS key + retain policy as the PHI bucket
    // (assembled packs contain PHI extracts). The assembler Lambda writes here with the
    // deterministic key `doctor-packs/<caseId>/v<N>/<doctorPackId>.pdf`.
    this.doctorPacksBucket = new s3.Bucket(this, 'DoctorPacksBucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.documentsKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }
}
