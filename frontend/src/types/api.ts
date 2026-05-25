import type { Role, Veteran, Case } from './prisma';

export interface ApiEnvelope<T> { readonly data: T; readonly requestId?: string; }
export interface ApiListEnvelope<T> { readonly data: readonly T[]; readonly nextCursor?: string; readonly requestId?: string; }
export interface ApiErrorEnvelope { readonly error: { readonly code: string; readonly message: string; readonly details?: Record<string, unknown> }; readonly requestId?: string; }
export interface CurrentUser { readonly sub: string; readonly email: string; readonly roles: readonly Role[]; readonly role: Role; }
export interface MockHealth { readonly ok: true; readonly user?: CurrentUser; }
export type VeteranListResponse = ApiListEnvelope<Veteran>;
export type CaseListResponse = ApiListEnvelope<Case>;
