import type { IncomingMessage, ServerResponse } from 'http';
import app from '../src/app';

/**
 * Vercel Node.js serverless entry point.
 * Bridges Node.js IncomingMessage → Fetch API Request → Hono → ServerResponse.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  // Build full URL from request
  const host = req.headers.host ?? 'localhost';
  const proto = (req.headers['x-forwarded-proto'] as string) ?? 'https';
  const url = `${proto}://${host}${req.url ?? '/'}`;

  // Read body
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const body = chunks.length > 0 ? Buffer.concat(chunks as Buffer[]) : undefined;

  // Reconstruct headers (IncomingMessage headers are flat key→value)
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      value.forEach((v) => headers.append(key, v));
    } else {
      headers.set(key, value);
    }
  }

  // Create Web API Request
  const fetchReq = new Request(url, {
    method: req.method ?? 'GET',
    headers,
    body: body?.length ? body : undefined,
  });

  // Dispatch through Hono
  const fetchRes = await app.fetch(fetchReq);

  // Write response
  res.statusCode = fetchRes.status;
  fetchRes.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  const buf = Buffer.from(await fetchRes.arrayBuffer());
  res.end(buf);
}
