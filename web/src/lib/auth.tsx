import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';

export interface User {
  id: string; email: string; name: string; role: 'admin' | 'client'; client_id: string | null; client_name?: string | null;
  totp_enabled: boolean; telegram_chat_id: string | null; notify_email: boolean; notify_telegram: boolean; notify_on_error: boolean;
  notify_weekly_summary: boolean; show_costs?: boolean; show_reports?: boolean; can_toggle?: boolean; can_retry?: boolean; client_logo?: string | null;
}
export interface Brand { productName: string; companyName: string; tagline: string; primaryColor: string; accentColor: string; logoUrl: string; supportEmail: string }

interface AuthState {
  user: User | null; brand: Brand | null; ready: boolean;
  setUser: (u: User | null) => void; refresh: () => Promise<void>; logout: () => Promise<void>;
}

const Ctx = createContext<AuthState>(null as any);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [brand, setBrand] = useState<Brand | null>(null);
  const [ready, setReady] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const r = await api.get<{ user: User | null }>('/api/auth/me');
      setUser(r.user);
    } catch { setUser(null); }
  }, []);
  useEffect(() => {
    Promise.all([refresh(), api.get<Brand>('/api/brand').then(setBrand).catch(() => {})]).finally(() => setReady(true));
    const onUnauth = () => setUser(null);
    window.addEventListener('jf:unauthorized', onUnauth);
    return () => window.removeEventListener('jf:unauthorized', onUnauth);
  }, [refresh]);
  useEffect(() => {
    if (brand) {
      document.documentElement.style.setProperty('--brand', brand.primaryColor);
      document.documentElement.style.setProperty('--accent', brand.accentColor);
    }
  }, [brand]);
  const logout = async () => {
    await api.post('/api/auth/logout').catch(() => {});
    setUser(null);
  };
  return <Ctx.Provider value={{ user, brand, ready, setUser, refresh, logout }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
