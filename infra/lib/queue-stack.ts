import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { aws_sqs as sqs } from 'aws-cdk-lib';
import type { CompactEmrConfig } from './config.js';

export interface QueueStackProps extends StackProps { config: CompactEmrConfig }

export class QueueStack extends Stack {
  public readonly draftQueue: sqs.Queue;
  public readonly deadLetterQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: QueueStackProps) {
    super(scope, id, props);

    this.deadLetterQueue = new sqs.Queue(this, 'DraftDeadLetterQueue', {
      queueName: `compact-emr-${props.config.envName}-draft-dlq`,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    this.draftQueue = new sqs.Queue(this, 'DraftQueue', {
      queueName: `compact-emr-${props.config.envName}-draft-queue`,
      visibilityTimeout: Duration.minutes(20),
      retentionPeriod: Duration.days(4),
      enforceSSL: true,
      deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: 3 },
    });
  }
}
