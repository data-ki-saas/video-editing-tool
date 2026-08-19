function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const env = {
  supabaseUrl: () => required("NEXT_PUBLIC_SUPABASE_URL"),
  supabaseAnonKey: () => required("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  r2Endpoint: () => required("R2_ENDPOINT"),
  r2AccessKeyId: () => required("R2_ACCESS_KEY_ID"),
  r2SecretAccessKey: () => required("R2_SECRET_ACCESS_KEY"),
  r2BucketName: () => required("R2_BUCKET_NAME"),
  r2PublicUrl: () => required("R2_PUBLIC_URL").replace(/\/$/, ""),
};