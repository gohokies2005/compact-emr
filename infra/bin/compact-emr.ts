#!/usr/bin/env node
import 'source-map-support/register.js';
import { App } from 'aws-cdk-lib';
import { getConfig, stackName } from '../lib/config.js';
import { NetworkStack } from '../lib/network-stack.js';
import { DatabaseStack } from '../lib/database-stack.js';
import { StorageStack } from '../lib/storage-stack.js';
import { AuthStack } from '../lib/auth-stack.js';
import { QueueStack } from '../lib/queue-stack.js';
import { ApiStack } from '../lib/api-stack.js';
import { FrontendStack } from '../lib/frontend-stack.js';
import { WorkersStack } from '../lib/workers-stack.js';
import { DrafterStack } from '../lib/drafter-stack.js';

const app = new App();
const config = getConfig(app);

const network = new NetworkStack(app, stackName(config, 'network'), { config, env: config.awsEnv });
const database = new DatabaseStack(app, stackName(config, 'database'), { config, vpc: network.vpc, env: config.awsEnv });
const storage = new StorageStack(app, stackName(config, 'storage'), { config, env: config.awsEnv });
const auth = new AuthStack(app, stackName(config, 'auth'), { config, env: config.awsEnv });
const queue = new QueueStack(app, stackName(config, 'queue'), { config, env: config.awsEnv });

// Phase 7B Doctor Pack + OCR workers. apiDomainName from config so this doesn't depend on
// ApiStack (would be circular: ApiStack needs WorkersStack.doctorPackQueue + workerToken).
const workers = new WorkersStack(app, stackName(config, 'workers'), {
  config,
  phiBucket: storage.phiBucket,
  doctorPacksBucket: storage.doctorPacksBucket,
  documentsKey: storage.documentsKey,
  // F6 — stuck-job watcher Lambda needs RDS access.
  vpc: network.vpc,
  database: database.database,
  databaseSecurityGroup: database.databaseSecurityGroup,
  databaseSecret: database.database.secret!,
  env: config.awsEnv,
});

new ApiStack(app, stackName(config, 'api'), {
  config,
  vpc: network.vpc,
  database: database.database,
  databaseSecurityGroup: database.databaseSecurityGroup,
  databaseSecret: database.database.secret!,
  userPool: auth.userPool,
  userPoolClient: auth.userPoolClient,
  draftQueue: queue.draftQueue,
  phiBucket: storage.phiBucket,
  doctorPacksBucket: storage.doctorPacksBucket,
  documentsKey: storage.documentsKey,
  doctorPackQueue: workers.doctorPackQueue,
  workerTokenSecret: workers.workerTokenSecret,
  draftJobQueue: workers.draftJobQueue,
  drafterInvokeTokenSecret: workers.drafterInvokeTokenSecret,
  chartExtractQueue: workers.chartExtractQueue,
  jotformIngestQueue: workers.jotformIngestQueue,
  env: config.awsEnv,
});

new FrontendStack(app, stackName(config, 'frontend'), { config, env: config.awsEnv });

// Drafter Fargate stack — runs the FRN drafter pipeline as a long-running ECS service.
// Scaffold-only on first deploy (desiredCount=0); operator pushes the drafter image to ECR
// and bumps desiredCount in a follow-up cdk deploy.
new DrafterStack(app, stackName(config, 'drafter'), {
  config,
  vpc: network.vpc,
  draftJobQueue: workers.draftJobQueue,
  drafterInvokeTokenSecret: workers.drafterInvokeTokenSecret,
  phiBucket: storage.phiBucket,
  doctorPacksBucket: storage.doctorPacksBucket,
  documentsKey: storage.documentsKey,
  env: config.awsEnv,
});
