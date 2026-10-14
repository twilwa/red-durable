export async function authorized(
  request: Request,
  token?: string,
): Promise<boolean> {
  if (!token || token.length < 32) return false;
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return false;
  const supplied =
    request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
  const enc = new TextEncoder();
  const a = new Uint8Array(
    await crypto.subtle.digest("SHA-256", enc.encode(token)),
  );
  const b = new Uint8Array(
    await crypto.subtle.digest("SHA-256", enc.encode(supplied)),
  );
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
export function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
export async function body(request: Request): Promise<Record<string, unknown>> {
  const value = await request.text();
  if (new TextEncoder().encode(value).length > 256_000)
    throw new Error("Request exceeds 256KB");
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Expected JSON object");
  return parsed as Record<string, unknown>;
}
export function string(value: unknown, max = 64_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error("Invalid string");
  return value;
}
