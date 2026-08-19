import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "@/lib/env";

function getClient(): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: env.r2Endpoint(),
    credentials: { accessKeyId: env.r2AccessKeyId(), secretAccessKey: env.r2SecretAccessKey() },
  });
}

export async function putAsset(key: string, body: Buffer, contentType: string): Promise<string> {
  await getClient().send(new PutObjectCommand({ Bucket: env.r2BucketName(), Key: key, Body: body, ContentType: contentType }));
  return `${env.r2PublicUrl()}/${key}`;
}

export async function deleteAsset(key: string): Promise<void> {
  await getClient().send(new DeleteObjectCommand({ Bucket: env.r2BucketName(), Key: key }));
}