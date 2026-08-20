-- MD5 of the uploaded bytes, used to dedupe uploads: multiple asset rows
-- (even across different projects for the same uploader) can point at the
-- same storage_key once a matching hash is found, so identical bytes are
-- never written to R2 twice. NULL for rows created before this migration.
-- Deliberately not unique -- one storage object is legitimately referenced
-- by more than one asset row; backend/src/assets/service.py reference-counts
-- by storage_key before ever deleting the underlying R2 object.
alter table public.assets add column if not exists content_hash text;

create index if not exists assets_uploaded_by_content_hash_idx
    on public.assets (uploaded_by, content_hash);
