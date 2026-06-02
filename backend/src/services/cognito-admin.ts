/**
 * Cognito admin operations for staff provisioning (POST /users). Injected into the users router
 * (deps.cognito) so the route is stub-testable with no AWS at type-check/test time — same pattern
 * as the letter render invoker + surgical proposer.
 *
 * Idempotency contract (see provisionUser): re-running with the same email NEVER creates a
 * duplicate — an existing Cognito user is found and its sub re-derived, groups are re-added
 * (no-op), the password is re-set. This is the recovery path when the DB write fails after the
 * Cognito side succeeded: the admin just re-submits the same form.
 *
 * CRITICAL: the stored identifier is the Cognito `sub` ATTRIBUTE (immutable, what the JWT carries
 * and what AppUser.cognitoSub / Physician.cognitoSub must match), NOT the Username. We always read
 * it back via AdminGetUser and throw if it is missing rather than persist a sub-less row.
 */
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminAddUserToGroupCommand,
  AdminSetUserPasswordCommand,
  AdminEnableUserCommand,
  AdminDisableUserCommand,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';

export type StaffCredential = { kind: 'invite' } | { kind: 'temp_password'; password: string };

export interface ProvisionCognitoUserInput {
  readonly email: string;
  readonly groups: readonly string[];
  readonly credential: StaffCredential;
}

export interface CognitoAdmin {
  /** Create (or find) the user, add to groups, set the password if temp. Returns the sub attribute. */
  provisionUser(input: ProvisionCognitoUserInput): Promise<{ sub: string }>;
  /** Enable/disable the login (offboarding). Identified by email = Username in our pool. */
  setUserEnabled(email: string, enabled: boolean): Promise<void>;
}

export function makeCognitoAdmin(userPoolId: string): CognitoAdmin {
  const client = new CognitoIdentityProviderClient({});

  async function getSub(email: string): Promise<string> {
    const res = await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }));
    const sub = res.UserAttributes?.find((a) => a.Name === 'sub')?.Value;
    if (!sub || sub.trim().length === 0) {
      throw new Error('Cognito user has no sub attribute; refusing to provision a sub-less AppUser.');
    }
    return sub;
  }

  return {
    async provisionUser({ email, groups, credential }: ProvisionCognitoUserInput): Promise<{ sub: string }> {
      try {
        await client.send(new AdminCreateUserCommand({
          UserPoolId: userPoolId,
          Username: email,
          // temp_password: suppress the Cognito invite email (we set a known password below).
          // invite: default MessageAction sends the invite email with a Cognito-generated temp password.
          ...(credential.kind === 'temp_password' ? { MessageAction: 'SUPPRESS' as const } : {}),
          UserAttributes: [
            { Name: 'email', Value: email },
            { Name: 'email_verified', Value: 'true' },
          ],
        }));
      } catch (err: unknown) {
        // Idempotent re-run: the user already exists — fall through to re-derive sub + re-apply groups.
        if (!(err instanceof UsernameExistsException)) throw err;
      }

      const sub = await getSub(email);

      // Ensure the login is enabled. No-op for a fresh create; the load-bearing call when
      // re-provisioning a previously-OFFBOARDED user (Cognito DISABLED) — without this the user
      // would be active in the DB + visible in pickers but unable to authenticate.
      await client.send(new AdminEnableUserCommand({ UserPoolId: userPoolId, Username: email }));

      for (const group of groups) {
        await client.send(new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: email, GroupName: group }));
      }

      if (credential.kind === 'temp_password') {
        await client.send(new AdminSetUserPasswordCommand({
          UserPoolId: userPoolId, Username: email, Password: credential.password, Permanent: true,
        }));
      }

      return { sub };
    },

    async setUserEnabled(email: string, enabled: boolean): Promise<void> {
      await client.send(enabled
        ? new AdminEnableUserCommand({ UserPoolId: userPoolId, Username: email })
        : new AdminDisableUserCommand({ UserPoolId: userPoolId, Username: email }));
    },
  };
}
