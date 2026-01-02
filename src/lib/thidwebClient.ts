// src/lib/thirdwebClient.ts
import { createThirdwebClient } from "thirdweb";

function assertEnv(name: string, value: string | undefined): string {
  const v = (value ?? "").trim();
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export const thirdwebClient = createThirdwebClient({
  clientId: assertEnv("VITE_THIRDWEB_CLIENT_ID", import.meta.env.VITE_THIRDWEB_CLIENT_ID),
});
