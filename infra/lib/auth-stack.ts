import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { aws_cognito as cognito, aws_iam as iam, aws_lambda as lambda, aws_lambda_nodejs as nodejs, aws_logs as logs } from 'aws-cdk-lib';
import type { CompactEmrConfig } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface AuthStackProps extends StackProps { config: CompactEmrConfig }

export class AuthStack extends Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly breakGlassMfaResetFunction: nodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `compact-emr-${props.config.envName}`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { sms: false, otp: true },
      // Remember-this-device (Ryan 2026-07-17): the 30-min idle logout forced Google-Authenticator
      // re-entry on EVERY re-login because Cognito never remembered the device. With device tracking,
      // a device the user OPTS IN to trust (deviceOnlyRememberedOnUserPrompt:true — user-prompted, NOT
      // auto, so a shared/public machine is never silently trusted) skips the OTP challenge on
      // subsequent logins; a NEW/untrusted device still gets the full OTP (challengeRequiredOnNewDevice).
      // HIPAA-safe: only user-chosen personal devices are remembered; the 30-min idle lock + 24h refresh
      // cap still apply. In-place UserPool update (no pool replacement, no user loss).
      deviceTracking: {
        challengeRequiredOnNewDevice: true,
        deviceOnlyRememberedOnUserPrompt: true,
      },
      passwordPolicy: {
        minLength: 12,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: true,
      },
      // Send Cognito auth email (invites, password resets, MFA) via SES on the verified
      // flatratenexus.com domain instead of COGNITO_DEFAULT (which silently dropped mail to the
      // domain — no SPF/DKIM alignment + ~50/day cap). Domain DKIM-verified in SES 2026-06-08.
      // Sandbox delivers to any @flatratenexus.com recipient (verified domain); production access
      // (pending) only needed for non-flatratenexus.com addresses.
      email: cognito.UserPoolEmail.withSES({
        fromEmail: 'no-reply@flatratenexus.com',
        fromName: 'Flat Rate Nexus',
        sesRegion: 'us-east-1',
        sesVerifiedDomain: 'flatratenexus.com',
      }),
    });

    this.userPoolClient = this.userPool.addClient('WebClient', {
      userPoolClientName: `compact-emr-${props.config.envName}-web`,
      authFlows: { userPassword: true, userSrp: true },
      preventUserExistenceErrors: true,
      // HIPAA session caps (Ryan 2026-07-10; refresh 12h→24h 2026-07-17). Access/ID tokens live 1h (the
      // frontend silently refreshes), but the REFRESH token is capped at 24h (was the 30-day Cognito
      // default) — so even a session left ACTIVE forces a fresh login at least daily. On a trusted device
      // (deviceTracking above) that daily re-login skips the OTP; a new device still gets full OTP. The
      // 30-min idle auto-logout (frontend) handles walked-away sessions. Changing these updates the
      // existing client in place (no client-id change, no forced logout of live sessions — the new
      // validity applies to newly issued tokens).
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.hours(24),
    });

    for (const groupName of ['physician', 'ops_staff', 'admin']) {
      new cognito.CfnUserPoolGroup(this, `${groupName}Group`, {
        userPoolId: this.userPool.userPoolId,
        groupName,
      });
    }

    const breakGlassLogGroup = new logs.LogGroup(this, 'BreakGlassMfaResetLogGroup', {
      logGroupName: `/aws/lambda/compact-emr-${props.config.envName}-break-glass-mfa-reset`,
      retention: logs.RetentionDays.SIX_MONTHS,
      removalPolicy: props.config.envName === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    this.breakGlassMfaResetFunction = new nodejs.NodejsFunction(this, 'BreakGlassMfaResetFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.resolve(__dirname, '../lambda/break-glass-mfa-reset.ts'),
      handler: 'handler',
      timeout: Duration.seconds(30),
      memorySize: 256,
      logGroup: breakGlassLogGroup,
      environment: {
        USER_POOL_ID: this.userPool.userPoolId,
      },
    });

    this.breakGlassMfaResetFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:AdminSetUserMFAPreference'],
      resources: [this.userPool.userPoolArn],
    }));
  }
}
