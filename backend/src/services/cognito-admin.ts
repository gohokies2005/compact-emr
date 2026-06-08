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
  AdminResetUserPasswordCommand,
  AdminSetUserMFAPreferenceCommand,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';
import { HttpError } from '../http/errors.js';

export type StaffCredential = { kind: 'invite' } | { kind: 'temp_password'; password: string };

/**
 * Validate a candidate password against the Cognito pool policy (min 12 + upper + lower + number +
 * symbol) BEFORE handing it to Cognito, so a weak password fails with a clean 400 here instead of a
 * 502 InvalidPasswordException from Cognito. Returns the validated password (trimmed of nothing — a
 * leading/trailing space is a legal password char). Throws an HttpError(400) on failure.
 *
 * Shared by the staff-create path (parseStaffCreate) and the temp-password reset path so the two
 * can never drift.
 */
export function assertCognitoPasswordPolicy(pw: unknown): string {
  if (
    typeof pw !== 'string' ||
    pw.length < 12 ||
    !/[A-Z]/.test(pw) ||
    !/[a-z]/.test(pw) ||
    !/[0-9]/.test(pw) ||
    !/[^A-Za-z0-9]/.test(pw)
  ) {
    throw new HttpError(
      400,
      'bad_request',
      'tempPassword must be at least 12 characters with an uppercase letter, a lowercase letter, a number, and a symbol',
      { field: 'tempPassword' },
    );
  }
  return pw;
}

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
  /** Trigger Cognito to email the user a password-reset code. No plaintext leaves the server. */
  resetPasswordEmail(email: string): Promise<void>;
  /** Set a known temp password that forces a change at next login (Permanent:false). */
  setTempPassword(email: string, password: string): Promise<void>;
  /** Clear both MFA factors AND re-enable the login, so a locked+disabled user recovers in one call. */
  clearMfa(email: string): Promise<void>;
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

    async resetPasswordEmail(email: string): Promise<void> {
      // Cognito emails the user a reset code via the pool's configured message flow. No password
      // material is generated or returned server-side — this is the safe default reset path.
      await client.send(new AdminResetUserPasswordCommand({ UserPoolId: userPoolId, Username: email }));
    },

    async setTempPassword(email: string, password: string): Promise<void> {
      // Permanent:false => Cognito puts the user into FORCE_CHANGE_PASSWORD; the temp password works
      // for exactly one login, after which the user must set their own.
      await client.send(new AdminSetUserPasswordCommand({
        UserPoolId: userPoolId, Username: email, Password: password, Permanent: false,
      }));
    },

    async clearMfa(email: string): Promise<void> {
      // Body lifted from infra/lambda/break-glass-mfa-reset.ts: disable both MFA factors so a user
      // locked out by a lost authenticator/phone can sign in again.
      await client.send(new AdminSetUserMFAPreferenceCommand({
        UserPoolId: userPoolId,
        Username: email,
        SMSMfaSettings: { Enabled: false, PreferredMfa: false },
        SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false },
      }));
      // THEN re-enable: a user disabled by offboarding (or auto-disabled) recovers in this one call.
      await client.send(new AdminEnableUserCommand({ UserPoolId: userPoolId, Username: email }));
    },
  };
}
