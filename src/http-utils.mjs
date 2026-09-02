import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import {
  brotliCompressSync,
  constants as zlibConstants,
  createBrotliCompress,
  createGzip,
  gzipSync,
} from "node:zlib";
import { BridgeError } from "./errors.mjs";

const COMPRESSIBLE_TYPES = /^(?:text\/|application\/(?:json|javascript|manifest\+json))/;
const MIN_COMPRESS_BYTES = 1024;
const MAX_SYNC_COMPRESS_BYTES = 8 * 1024 * 1024;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

export function requestId(request) {
  const supplied = request.headers["x-request-id"];
  return typeof supplied === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(supplied)
    ? supplied
    : randomUUID();
}

export function commonHeaders(id) {
  return {
    "X-Request-Id": id,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  };
}

function preferredEncoding(request, contentType, size) {
  if (size < MIN_COMPRESS_BYTES || !COMPRESSIBLE_TYPES.test(contentType)) return null;
  const accepted = String(request?.headers?.["accept-encoding"] || "").toLowerCase();
  if (/\bbr\b/.test(accepted)) return "br";
  if (/\bgzip\b/.test(accepted)) return "gzip";
  return null;
}

function compressedBuffer(body, encoding) {
  if (!encoding || body.length > MAX_SYNC_COMPRESS_BYTES) return { body, encoding: null };
  if (encoding === "br") {
    return {
      body: brotliCompressSync(body, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
      }),
      encoding,
    };
  }
  return { body: gzipSync(body, { level: 5 }), encoding };
}

export function json(response, status, value, id) {
  const rawBody = Buffer.from(JSON.stringify(value));
  const compressed = compressedBuffer(
    rawBody,
    preferredEncoding(response.req, "application/json", rawBody.length),
  );
  response.writeHead(status, {
    ...commonHeaders(id),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": compressed.body.length,
    "Cache-Control": "no-store",
    Vary: "Accept-Encoding",
    ...(compressed.encoding ? { "Content-Encoding": compressed.encoding } : {}),
  });
  response.end(compressed.body);
}

export async function readJson(request, maxBytes = 64 * 1024) {
  const contentType = String(request.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new BridgeError("请求必须使用 application/json", { status: 415, code: "unsupported_media_type" });
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new BridgeError("请求内容过大", { status: 413, code: "body_too_large" });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BridgeError("JSON 格式无效", { status: 400, code: "invalid_json" });
  }
}

export function rejectCrossSiteMutation(request) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method || "")) return;
  if (String(request.headers["sec-fetch-site"] || "").toLowerCase() === "cross-site") {
    throw new BridgeError("拒绝跨站操作", { status: 403, code: "cross_site_request" });
  }
}

export function serveStatic(request, response, publicDir, pathname, id) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new BridgeError("URL 路径无效", { status: 400, code: "invalid_path" });
  }
  const requested = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const filePath = resolve(publicDir, requested);
  const relativePath = relative(publicDir, filePath);
  if (relativePath.startsWith("..") || relativePath.includes(":") || !existsSync(filePath)) return false;
  const stat = statSync(filePath);
  if (!stat.isFile()) return false;
  const contentType = MIME_TYPES[extname(filePath)] || "application/octet-stream";
  const encoding = preferredEncoding(request, contentType, stat.size);
  const etag = `"${createHash("sha1").update(`${stat.size}:${stat.mtimeMs}:${encoding || "identity"}`).digest("hex")}"`;
  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, { ...commonHeaders(id), ETag: etag, "Cache-Control": "no-cache", Vary: "Accept-Encoding" });
    response.end();
    return true;
  }
  response.writeHead(200, {
    ...commonHeaders(id),
    "Content-Type": contentType,
    ...(!encoding ? { "Content-Length": stat.size } : { "Content-Encoding": encoding }),
    "Cache-Control": "no-cache",
    Vary: "Accept-Encoding",
    ETag: etag,
  });
  if (request.method === "HEAD") response.end();
  else {
    const file = createReadStream(filePath);
    file.on("error", () => response.destroy());
    if (encoding === "br") file.pipe(createBrotliCompress({ params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } })).pipe(response);
    else if (encoding === "gzip") file.pipe(createGzip({ level: 5 })).pipe(response);
    else file.pipe(response);
  }
  return true;
}
