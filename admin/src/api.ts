import axios from 'axios';

export const api = axios.create({
  baseURL: '/api',
  timeout: 60000,
});

const TOKEN_KEY = 'stock_monitor_token';

export function getAuthToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAuthToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // ignore
  }
}

export function clearAuthToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

api.interceptors.request.use((config) => {
  const token = getAuthToken();
  if (token) {
    (config.headers as any) = (config.headers as any) || {};
    (config.headers as any).Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (error) => {
    const status = error?.response?.status;
    console.log('api error', error);
    if (status === 401) {
      clearAuthToken();
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    } else if (status === 403) {
      // TODO: 处理403权限不足
      console.error('权限不足');
      const data = error?.response?.data;
      if (data && typeof data === 'object' && (data as any).message === 'Forbidden') {
        (data as any).message = '权限不足';
      }
    }
    return Promise.reject(error);
  },
);
