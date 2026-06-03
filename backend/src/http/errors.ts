import type { Response } from 'express';

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'chart_not_ready'
  | 'essential_docs_missing'
  | 'internal_error';

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

export function sendError(res: Response, status: number, code: ErrorCode, message: string, details?: unknown): Response {
  const payload: ErrorEnvelope = {
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
  };
  return res.status(status).json(payload);
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function isHttpError(error: unknown): error is HttpError {
  return error instanceof HttpError;
}
