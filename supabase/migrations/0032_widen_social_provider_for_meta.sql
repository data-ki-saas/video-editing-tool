-- Adds Facebook ("meta") and Instagram as connectable social_accounts/
-- social_posts providers alongside youtube -- see backend/src/social/
-- providers/meta_provider.py and META_APP_REVIEW.md. `instagram` rows are
-- created transparently when a user connects `meta` (one Facebook Login
-- consent covers both), not through a separate OAuth flow of their own.
alter table public.social_accounts drop constraint social_accounts_provider_check;
alter table public.social_accounts add constraint social_accounts_provider_check
    check (provider in ('youtube', 'meta', 'instagram'));

alter table public.social_posts drop constraint social_posts_provider_check;
alter table public.social_posts add constraint social_posts_provider_check
    check (provider in ('youtube', 'meta', 'instagram'));
