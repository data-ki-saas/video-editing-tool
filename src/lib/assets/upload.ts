import type { SupabaseClient } from "@supabase/supabase-js";
import type { Asset, Database } from "@/types/database";
import { deleteAsset, putAsset } from "@/lib/storage/r2";

const allowedTypes = {
  "video/mp4": "video",
  "image/jpeg": "image",
  "image/png": "image",
} as const;

export type UploadableAsset = { name: string; type: string; size: number; arrayBuffer(): Promise<ArrayBuffer> };

export async function uploadAsset(
  supabase: SupabaseClient<Database>,
  projectId: string,
  userId: string,
  file: UploadableAsset,
): Promise<Asset> {
  const kind = allowedTypes[file.type as keyof typeof allowedTypes];
  if (!kind || !/\.(mp4|jpe?g|png)$/i.test(file.name)) {
    throw new Error("Only .mp4, .jpg, and .png files are supported");
  }
  if (file.size <= 0 || file.size > 500 * 1024 * 1024) throw new Error("File must be smaller than 500 MB");

  const filename = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const storageKey = `projects/${projectId}/${crypto.randomUUID()}-${filename}`;
  const publicUrl = await putAsset(storageKey, Buffer.from(await file.arrayBuffer()), file.type);

  const { data, error } = await supabase
    .from("assets")
    .insert({ project_id: projectId, uploaded_by: userId, filename: file.name, kind, mime_type: file.type as Asset["mime_type"], size_bytes: file.size, storage_key: storageKey, public_url: publicUrl })
    .select()
    .single();

  if (error) {
    await deleteAsset(storageKey).catch(() => undefined);
    throw new Error(`Asset metadata insert failed: ${error.message}`);
  }
  return data;
}