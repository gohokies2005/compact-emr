import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

export async function resolveDatabaseUrl(): Promise<string> {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const secretArn = process.env.DATABASE_URL_SECRET_ARN;
  if (!secretArn) throw new Error('DATABASE_URL or DATABASE_URL_SECRET_ARN is required.');

  const client = new SecretsManagerClient({});
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!response.SecretString) throw new Error('Database secret did not contain SecretString.');

  const secret = JSON.parse(response.SecretString) as { username: string; password: string; host: string; port: number; dbname?: string };
  return `postgresql://${encodeURIComponent(secret.username)}:${encodeURIComponent(secret.password)}@${secret.host}:${secret.port}/${secret.dbname ?? 'compact_emr'}?schema=public`;
}
