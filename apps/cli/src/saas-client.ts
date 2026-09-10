import { saasEndpoint } from "@contremaitre/environments/tunnel-provider";
import { fail, HubError } from "@contremaitre/execution/context";
import { Schema } from "effect";

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export class AuthenticationRequired extends Error {}
export function read<A, I>(schema: Schema.Schema<A, I>, value: unknown): A {
  try {
    return Schema.decodeUnknownSync(schema)(value);
  } catch {
    return fail("Invalid response from the SaaS provider");
  }
}
export async function bytes(response: Response, limit: number) {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (!reader) return Buffer.alloc(0);
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > limit) {
        await reader.cancel();
        fail("SaaS response exceeds the download limit");
      }
      chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } finally {
    reader.releaseLock();
  }
}
export function sameOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value, saasEndpoint);
  } catch {
    return fail("Invalid SaaS URL");
  }
  if (url.origin !== saasEndpoint || url.username || url.password || url.hash)
    fail("SaaS URL must use the configured HTTPS origin");
  return url.href;
}
export function api(signal: AbortSignal, fetcher: Fetch = fetch) {
  return async (path: string, token?: string, body?: URLSearchParams | object) => {
    signal.throwIfAborted();
    try {
      const response = await fetcher(sameOrigin(path), {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body && !(body instanceof URLSearchParams)
            ? { "content-type": "application/json" }
            : {}),
        },
        body: body instanceof URLSearchParams ? body : body ? JSON.stringify(body) : undefined,
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        throw new AuthenticationRequired("SaaS authentication is required");
      }
      if (!response.ok && !(path === "/oauth/device/token" && response.status === 400)) {
        await response.body?.cancel();
        fail(
          `SaaS provider unavailable (HTTP ${response.status}); try contremaitre tunnel again later`,
        );
      }
      return JSON.parse((await bytes(response, 1 << 20)).toString("utf8")) as unknown;
    } catch (e) {
      signal.throwIfAborted();
      if (e instanceof AuthenticationRequired || e instanceof HubError) throw e;
      return fail("Cannot reach the SaaS provider; try contremaitre tunnel again later");
    }
  };
}
