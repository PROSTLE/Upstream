import { createContext, useContext, type ReactNode } from "react";
import { api, setAdminToken, setSignedIn, useApi } from "./api.ts";

export type AuthUser = { login: string; name: string | null; avatar_url: string | null; role: "operator" | "member" };
type Auth = { user: AuthUser | null; available: boolean; loading: boolean; signOut: () => Promise<void> };

async function signOut() {
  setAdminToken(null);
  try {
    await api("/api/auth/logout", { body: {} });
  } finally {
    window.location.assign("/");
  }
}

const AuthCtx = createContext<Auth>({ user: null, available: false, loading: true, signOut });
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { data, loading } = useApi<{ user: AuthUser | null; github_login_available: boolean }>("/api/auth/me");
  const user = data?.user ?? null;
  // Set while rendering, so the first dashboard request already knows the cookie speaks for this person.
  setSignedIn(Boolean(user));
  return <AuthCtx.Provider value={{ user, available: Boolean(data?.github_login_available), loading, signOut }}>{children}</AuthCtx.Provider>;
}
