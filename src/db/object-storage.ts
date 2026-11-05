import { S3Client, PutObjectCommand, GetObjectCommand, HeadBucketCommand, CreateBucketCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const BUCKET = process.env.MEDIA_BUCKET || "omni-platform-media";

let client: S3Client | null = null;

/**
 * Works against real AWS S3, GCS's S3-interoperability mode, or a
 * self-hosted MinIO — the point of using the S3 API surface rather than a
 * provider-specific SDK (per architecture doc §3: "S3 or GCS", "cheap,
 * durable, scales independently"). forcePathStyle is needed for MinIO/most
 * self-hosted S3-compatible servers; real AWS ignores it harmlessly.
 */
export function getS3Client(): S3Client {
  if (!client) {
    client = new S3Client({
      region: process.env.MEDIA_S3_REGION || "us-east-1",
      endpoint: process.env.MEDIA_S3_ENDPOINT, // unset = real AWS; set = MinIO/self-hosted/local test double
      forcePathStyle: !!process.env.MEDIA_S3_ENDPOINT,
      credentials: process.env.MEDIA_S3_ACCESS_KEY
        ? {
            accessKeyId: process.env.MEDIA_S3_ACCESS_KEY,
            secretAccessKey: process.env.MEDIA_S3_SECRET_KEY || "",
          }
        : undefined, // falls back to the default AWS credential chain
    });
  }
  return client;
}

/**
 * Creates the bucket if it doesn't exist yet. Only meant for local/dev
 * against MinIO (see the MEDIA_S3_ENDPOINT check at the call site in
 * index.ts) — against real AWS S3, bucket provisioning is normally IaC's
 * job (Terraform, CloudFormation, etc.), not something the app does at
 * startup, and the app's IAM credentials often can't create buckets anyway.
 */
export async function ensureMediaBucketExists(): Promise<void> {
  const s3 = getS3Client();
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
  }
}

export async function uploadMedia(params: {
  key: string;
  body: Buffer;
  contentType: string;
}): Promise<{ key: string; bucket: string }> {
  const s3 = getS3Client();
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType,
    })
  );
  return { key: params.key, bucket: BUCKET };
}

/** A time-limited URL a client can use to fetch the media without needing storage credentials. */
export async function getMediaDownloadUrl(key: string, expiresInSeconds = 3600): Promise<string> {
  const s3 = getS3Client();
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
    expiresIn: expiresInSeconds,
  });
}

/** Meta downloads a template header right after the send request, so a day is plenty. */
const HEADER_MEDIA_URL_TTL_SECONDS = 24 * 60 * 60;

/**
 * URL to hand to WhatsApp for a template's media header. An uploaded file is always signed fresh
 * from its storage key: the URL saved on a flow node or campaign at upload time expires (7 days at
 * most), so reusing it would break every send after that. `savedValue` is the pasted external URL or
 * {{variable}} result, used when there is no storage key (or as a fallback if signing fails).
 */
export async function resolveHeaderMediaUrl(
  mediaStorageKey: string | undefined,
  savedValue: string | undefined
): Promise<string | undefined> {
  if (!mediaStorageKey) return savedValue;
  try {
    return await getMediaDownloadUrl(mediaStorageKey, HEADER_MEDIA_URL_TTL_SECONDS);
  } catch (err) {
    if (savedValue) return savedValue;
    throw err;
  }
}

/** Fetch media object body and headers directly for streaming through API */
export async function getMediaObject(key: string): Promise<{ body: any; contentType: string; contentLength?: number }> {
  const s3 = getS3Client();
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return {
    body: res.Body,
    contentType: res.ContentType || "application/octet-stream",
    contentLength: res.ContentLength,
  };
}
