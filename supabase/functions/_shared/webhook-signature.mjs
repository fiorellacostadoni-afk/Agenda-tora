export async function verifyWebhookSignature(request, dataId, secret) {
  const signature = request.headers.get("x-signature") || "";
  const requestId = request.headers.get("x-request-id") || "";
  const parts = Object.fromEntries(signature.split(",").map((part) => {
    const [key, ...rest] = part.trim().split("=");
    return [key, rest.join("=")];
  }));
  if (!parts.ts || !parts.v1 || !requestId || !dataId) return false;
  const manifest = `id:${dataId};request-id:${requestId};ts:${parts.ts};`;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(manifest)));
  const expected = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (expected.length !== parts.v1.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return difference === 0;
}
