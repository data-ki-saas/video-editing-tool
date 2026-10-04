-- Free-form grouping for the shared catalog ("props", "fire-smoke", ...), so
-- the editor's Props dialog can list just the placeable artwork without a
-- new asset_type. Null for avatars and anything promoted by a user.
alter table public.public_library_assets add column if not exists category text;

create index if not exists public_library_assets_category_idx
    on public.public_library_assets (category)
    where category is not null;
