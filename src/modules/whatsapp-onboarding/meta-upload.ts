import { getMediaObject } from "../../db/object-storage";

/**
 * Meta only accepts a template header example as a handle from its Resumable Upload API —
 * a plain URL in `example.header_handle` is rejected with "Invalid parameter".
 */

async function readBody(body: any): Promise<Buffer> {
  if (body && typeof body.transformToByteArray === "function") {
    return Buffer.from(await body.transformToByteArray());
  }
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Loads the header file from object storage (by key), or by downloading a public URL. */
async function loadHeaderFile(
  mediaStorageKey: string | undefined,
  source: string | undefined
): Promise<{ bytes: Buffer; contentType: string; filename: string }> {
  let key = mediaStorageKey;
  if (!key && source?.startsWith("/api/media/file")) {
    key = new URL(source, "http://local").searchParams.get("key") || undefined;
  }

  if (key) {
    const obj = await getMediaObject(key);
    return {
      bytes: await readBody(obj.body),
      contentType: obj.contentType,
      filename: key.split("/").pop() || "header",
    };
  }

  if (source && /^https?:\/\//i.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Header media is not accessible (HTTP ${res.status})`);
    const contentType = (res.headers.get("content-type") || "application/octet-stream").split(";")[0];
    const filename = decodeURIComponent(new URL(source).pathname.split("/").pop() || "header");
    return { bytes: Buffer.from(await res.arrayBuffer()), contentType, filename };
  }

  throw new Error("Header media file is missing — upload an image, video or document for the header");
}

export function isMetaUploadHandle(value: string | undefined): boolean {
  return !!value && !/^https?:\/\//i.test(value) && !value.startsWith("/");
}

/** Uploads a header sample to Meta and returns the handle for `example.header_handle`. */
export async function uploadHeaderSample(params: {
  accessToken: string;
  apiBaseUrl: string;
  mediaStorageKey?: string;
  source?: string;
}): Promise<string> {
  const appId = process.env.META_APP_ID;
  if (!appId) throw new Error("META_APP_ID is not configured in backend/.env");

  const { bytes, contentType, filename } = await loadHeaderFile(params.mediaStorageKey, params.source);

  const sessionUrl =
    `${params.apiBaseUrl}/${appId}/uploads` +
    `?file_name=${encodeURIComponent(filename)}&file_length=${bytes.length}&file_type=${encodeURIComponent(contentType)}`;
  const sessionRes = await fetch(sessionUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${params.accessToken}` },
  });
  const session: any = await sessionRes.json().catch(() => ({}));
  if (!sessionRes.ok || !session.id) {
    throw new Error(`Meta upload session failed: ${session?.error?.message || sessionRes.status}`);
  }

  const uploadRes = await fetch(`${params.apiBaseUrl}/${session.id}`, {
    method: "POST",
    headers: { Authorization: `OAuth ${params.accessToken}`, file_offset: "0" },
    body: bytes,
  });
  const uploaded: any = await uploadRes.json().catch(() => ({}));
  if (!uploadRes.ok || !uploaded.h) {
    throw new Error(`Meta file upload failed: ${uploaded?.error?.message || uploadRes.status}`);
  }
  return uploaded.h as string;
}
