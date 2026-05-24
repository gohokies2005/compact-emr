import type { App, Environment } from 'aws-cdk-lib';

export type CompactEmrConfig = {
  envName: 'staging' | 'prod';
  domainName: string;
  apiDomainName: string;
  hostedZoneName: string;
  hostedZoneId: string;
  deletionProtection: boolean;
  awsEnv?: Environment;
};

export function getConfig(app: App): CompactEmrConfig {
  const envName = app.node.tryGetContext('env');
  if (envName !== 'staging' && envName !== 'prod') {
    throw new Error('Pass --context env=staging or --context env=prod');
  }
  const raw = app.node.tryGetContext(envName) as Omit<CompactEmrConfig, 'envName'>;
  return {
    ...raw,
    envName,
    awsEnv: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
    },
  };
}

export function stackName(config: CompactEmrConfig, suffix: string): string {
  return `compact-emr-${config.envName}-${suffix}`;
}
