import type { ResourcesConfig } from 'aws-amplify';
import { env } from '../env';

export const amplifyConfig: ResourcesConfig = {
  Auth: {
    Cognito: {
      userPoolId: env.cognitoUserPoolId,
      userPoolClientId: env.cognitoClientId
    }
  }
};
