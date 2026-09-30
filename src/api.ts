import { useCallback, useEffect, useState } from 'react';

export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
let csrfToken = '';
export function setCsrf(value: string | null) { csrfToken = value || ''; }
export async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type','application/json');
  if (init.method && init.method !== 'GET') headers.set('X-CSRF-Token',csrfToken);
  const response = await fetch(url,{ ...init, headers, credentials: 'same-origin' });
  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: 'The server could not be reached. Try again.' }));
    throw new ApiError(data.error || 'Request failed.',response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}
export function useResource<T>(url: string) {
  const [data,setData] = useState<T | null>(null);
  const [error,setError] = useState<string | null>(null);
  const [loading,setLoading] = useState(true);
  const [version,setVersion] = useState(0);
  const reload = useCallback(() => setVersion(value => value+1),[]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null); setData(null);
    api<T>(url,{ signal: controller.signal }).then(setData).catch(error => { if (!controller.signal.aborted) setError(error.message || 'Connection failed.'); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  },[url,version]);
  return { data,error,loading,reload,setData };
}
