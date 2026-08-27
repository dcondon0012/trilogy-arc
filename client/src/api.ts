export class ApiError extends Error {
  status: number;
  data: any;
  constructor(status: number, message: string, data?: any) { super(message); this.status = status; this.data = data; }
}

export async function api(method: string, path: string, body?: any): Promise<any> {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new ApiError(res.status, data?.error || res.statusText, data);
  return data;
}

export async function apiUpload(path: string, file: File, extra?: Record<string, string>): Promise<any> {
  const fd = new FormData();
  fd.append('file', file);
  for (const [k, v] of Object.entries(extra || {})) fd.append(k, v);
  const res = await fetch('/api' + path, { method: 'POST', body: fd, credentials: 'same-origin' });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error || res.statusText, data);
  return data;
}
