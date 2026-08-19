-- The R2 bucket is now private: reads go through a short-lived presigned URL
-- generated per-request by the backend (see backend/src/storage/r2_client.py),
-- not a permanent public link. A stored public_url would be misleading (it
-- was never revoked-able) and is no longer used anywhere.
alter table public.assets drop column if exists public_url;
