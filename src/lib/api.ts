const SESSION_TOKEN_KEY = 'wanexus_owner_session_token';
const SESSION_EMAIL_KEY = 'wanexus_owner_session_email';

export function getStoredSessionToken(): string | null {
  try {
    return sessionStorage.getItem(SESSION_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getStoredSessionEmail(): string | null {
  try {
    return sessionStorage.getItem(SESSION_EMAIL_KEY);
  } catch {
    return null;
  }
}

export function setStoredSession(token: string, email: string) {
  try {
    sessionStorage.setItem(SESSION_TOKEN_KEY, token);
    sessionStorage.setItem(SESSION_EMAIL_KEY, email);
  } catch {
    // ignore storage errors
  }
}

export function clearStoredSession() {
  try {
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
    sessionStorage.removeItem(SESSION_EMAIL_KEY);
  } catch {
    // ignore storage errors
  }
}

export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const token = getStoredSessionToken();
  const headers = new Headers(init?.headers || {});
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const response = await fetch(input, {
    ...init,
    headers,
  });

  if (response.status === 401) {
    const urlStr = typeof input === 'string' ? input : input.toString();
    if (!urlStr.includes('/api/auth/')) {
      clearStoredSession();
      window.dispatchEvent(new CustomEvent('wanexus:unauthorized'));
    }
  }

  return response;
}
