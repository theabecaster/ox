import type { Settings } from "./types.js";
import { DEFAULT_GATEWAY_URL } from "./types.js";

export const RELEASE_GATEWAY_URL =
  process.env.OX_RELEASE_GATEWAY ?? "https://ox-gateway.vercel.app/v1";

export interface Endpoint {
  baseUrl: string;
  apiKey: string | null;
  usingGateway: boolean;
  source: string;
}

export function resolveEndpoint(
  opts: {
    key?: string | null;
    keySource?: string;
    settings?: Partial<Settings>;
    env?: Record<string, string | undefined>;
  },
): Endpoint {
  const e = opts.env ?? process.env;
  const explicitBase = e.OX_BASE_URL ?? opts.settings?.gateway;
  const key = opts.key ?? null;

  if (explicitBase) {
    return {
      baseUrl: explicitBase,
      apiKey: key,
      usingGateway: false,
      source: key ? `${opts.keySource ?? "key"} @ ${explicitBase}` : `gateway ${explicitBase}`,
    };
  }
  if (key) {
    return {
      baseUrl: DEFAULT_GATEWAY_URL,
      apiKey: key,
      usingGateway: false,
      source: opts.keySource ?? "key",
    };
  }
  return {
    baseUrl: RELEASE_GATEWAY_URL,
    apiKey: null,
    usingGateway: true,
    source: "free gateway",
  };
}
