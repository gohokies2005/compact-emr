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

const app = new App();
const config = getConfig(app);

const network = new NetworkStack(app, stackName(config, 'network'), { config, env: config.awsEnv });
const database = new DatabaseStack(app, stackName(config, 'database'), { config, vpc: network.vpc, env: config.awsEnv });
const storage = new StorageStack(app, stackName(config, 'storage'), { config, env: config.awsEnv });
const auth = new AuthStack(app, stackName(config, 'auth'), { config, env: config.awsEnv });
const queue = new QueueStack(app, stackName(config, 'queue'), { config, env: config.awsEnv });

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
  documentsKey: storage.documentsKey,
  env: config.awsEnv,
});

new FrontendStack(app, stackName(config, 'frontend'), { config, env: config.awsEnv });
