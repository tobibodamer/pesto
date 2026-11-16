import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * `fetch` that goes through Rust when running in the app, so model and voice
 * APIs are reachable without CORS and keys never touch a browser origin.
 */
export const http: typeof fetch = (input, init) => (inTauri ? tauriFetch(input, init) : fetch(input, init));

export async function postJson<T>(url: string, body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
  const res = await http(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`${res.status} ${url}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

/** Yields the `data:` payloads of a server-sent-event response as they arrive. */
export async function* sse(res: Response): AsyncGenerator<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
}
