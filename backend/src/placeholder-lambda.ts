import serverless from 'serverless-http';
import { createApp } from './server.js';

export const handler = serverless(createApp());
