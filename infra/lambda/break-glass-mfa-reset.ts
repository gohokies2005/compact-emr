import { AdminSetUserMFAPreferenceCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';

const client = new CognitoIdentityProviderClient({});

export async function handler(event: { username?: string; userPoolId?: string }) {
  const userPoolId = event.userPoolId ?? process.env.USER_POOL_ID;
  const username = event.username;

  if (!userPoolId || !username) {
    throw new Error('username and userPoolId are required. userPoolId may come from USER_POOL_ID.');
  }

  await client.send(new AdminSetUserMFAPreferenceCommand({
    UserPoolId: userPoolId,
    Username: username,
    SMSMfaSettings: { Enabled: false, PreferredMfa: false },
    SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false },
  }));

  return { ok: true, username, userPoolId, action: 'mfa_preferences_cleared' };
}
