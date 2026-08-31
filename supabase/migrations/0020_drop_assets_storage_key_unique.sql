-- 0009_add_content_hash_to_assets.sql introduced content-hash dedup: multiple
-- asset rows (even across different projects for the same uploader) can
-- legitimately point at the same storage_key once a matching hash is found
-- (see repository.py's find_by_content_hash / count_assets_with_storage_key).
-- The unique constraint from 0001_create_media_schema.sql was never dropped
-- to match, so the very first cross-project dedup hit fails the insert with
-- "duplicate key value violates unique constraint assets_storage_key_key".
alter table public.assets drop constraint if exists assets_storage_key_key;

create index if not exists assets_storage_key_idx on public.assets (storage_key);
