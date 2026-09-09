export function noStoreResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store, private");
  headers.set("CDN-Cache-Control", "no-store");
  headers.set("Cloudflare-CDN-Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
export function appHealthResponse(version: string, serverTime = Date.now()): Response {
  return noStoreResponse(Response.json({ version, serverTime }));
}
