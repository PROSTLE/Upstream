import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useApi } from "./api.ts";

// The product name and public URL come from the server (BRAND_NAME, PUBLIC_BASE_URL), never from the bundle.
type Brand = { name: string; publicBaseUrl: string | null; features: Record<string, boolean> | null; access: "private" | "public" | null; error: string | null };
const BrandCtx = createContext<Brand>({ name: "", publicBaseUrl: null, features: null, access: null, error: null });

export function BrandProvider({ children }: { children: ReactNode }) {
  const { data, error } = useApi<any>("/api/health");
  const name = data?.brand ?? "";
  useEffect(() => {
    if (name) document.title = name;
  }, [name]);
  return <BrandCtx.Provider value={{ name, publicBaseUrl: data?.public_base_url ?? null, features: data?.features ?? null, access: data?.dashboard_access ?? null, error }}>{children}</BrandCtx.Provider>;
}

/** The server's BRAND_NAME; empty until /api/health has answered. */
export const useBrand = () => useContext(BrandCtx).name;
export const useHealth = () => useContext(BrandCtx);
