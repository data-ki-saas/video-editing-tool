# Media timeline storage

Next.js App Router utilities for a timeline editor. Supabase stores users,
projects, timeline JSON, and asset metadata. Cloudflare R2 stores the uploaded
media bytes.

## Setup

1. Create a Supabase project and run `supabase/migrations/0001_create_media_schema.sql`.
2. Create an R2 bucket and an R2 API token with object read/write access.
3. Copy `.env.example` to `.env.local` and fill in the Supabase and R2 values.
4. Run `npm install` and `npm run dev`.

`R2_PUBLIC_URL` must point to the public bucket URL or a custom domain. The
database trigger creates a `public.users` row whenever Supabase Auth creates a
user. Existing Auth users can be synchronized once with:

```sql
insert into public.users (id, email)
select id, email from auth.users
on conflict (id) do nothing;
```

## Upload API

`POST /api/assets` accepts a multipart form request with `projectId`, a `file`,
and an `Authorization: Bearer <supabase access token>` header. Files must be
`.mp4`, `.jpg`, or `.png` and are limited to 500 MB.

```bash
curl -X POST http://localhost:3000/api/assets \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -F "projectId=$PROJECT_ID" \
  -F "file=@./clip.mp4;type=video/mp4"
```

The route verifies the token, uploads to `projects/<project-id>/` in R2, and
inserts the corresponding `assets` row through the user-scoped Supabase client.
RLS enforces that only the project owner can add, view, or delete assets. If
the metadata insert fails, the uploaded R2 object is deleted.
