import { useQuery } from '@tanstack/react-query';
import { apiGet } from './client';
import type { CaseListResponse, VeteranListResponse } from '../types/api';

export function useVeterans() { return useQuery({ queryKey: ['veterans'], queryFn: () => apiGet<VeteranListResponse>('/api/v1/veterans') }); }
export function useCases() { return useQuery({ queryKey: ['cases'], queryFn: () => apiGet<CaseListResponse>('/api/v1/cases') }); }
