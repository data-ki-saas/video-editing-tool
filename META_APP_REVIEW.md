# Meta App Review — submission draft

Status: **draft + connect/publish code both exist now; not yet submitted,
and not yet exercised against a real Meta app.** Prepared alongside the
YouTube posting feature (see `backend/src/social/`) so the review clock
can start as soon as the prerequisites below are in place — Meta's review
turnaround (days-to-weeks, sometimes bounced back for revisions) is the
long pole for Facebook/Instagram posting, not the integration code itself.
See project memory "Social posting backburner" for the original feasibility
findings this continues from.

**This document cannot be submitted as-is.** Meta's review requires a
screencast of each permission actually being exercised against a real test
Page/Instagram Business account — see "What's still needed" at the bottom
before treating this as ready to send.

---

## App overview (for the review form's "how does your app use Facebook
Login" question)

[App name] lets an independent creator (real estate agent, small-business
owner, etc. — see root `CLAUDE.md`'s "driving vision") turn raw phone/GoPro
footage into a finished short-form vertical video ("reel"). Once a reel is
rendered, the app lets that same creator publish it directly to their own
Facebook Page and/or Instagram Business account in one click, instead of
manually downloading the file and re-uploading it through each platform's
own app. The app never posts to anyone's personal Facebook profile, never
posts on a schedule or automatically, and never posts anything the user
didn't explicitly click "Post" on.

Architecturally this mirrors the YouTube posting feature already built:
each user connects their own Facebook/Instagram account once (OAuth), the
app stores their access token, and a later "Post to Instagram"/"Post to
Facebook Page" click uploads that specific, already-saved reel.

## Requested permissions and why

| Permission | Why this app needs it | What it's used for, exactly |
|---|---|---|
| `pages_show_list` | To let the user pick which of their Facebook Pages to connect (a user may manage more than one) | Read-only: lists the Pages the logged-in user administers, shown as a picker in Settings |
| `pages_manage_posts` | To publish a finished reel as a post on the user's own connected Page | Write-only in effect: `POST /{page-id}/videos` with the reel's own R2-hosted MP4 URL, a title, and a description the user can edit before posting. Never reads, edits, or deletes any existing Page post |
| `pages_read_engagement` | Required by Meta as a prerequisite for `pages_manage_posts` on some API paths (confirm exact requirement at submission time — Meta's requirements shift between review cycles) | Not used for analytics/reporting in this app at all; requested only because the Graph API path requires it alongside `pages_manage_posts` |
| `instagram_basic` | To identify which Instagram Business account is linked to the connected Page, shown in Settings | Read-only: account id + username |
| `instagram_content_publish` | To publish a finished reel as an Instagram Reel/post on the user's own connected Instagram Business account | Write-only in effect: Instagram's two-step container-create-then-publish flow (`POST /{ig-user-id}/media` then `POST /{ig-user-id}/media_publish`), using the reel's own R2-hosted MP4 URL |

## Data handling summary (for the review form's data-use questions)

- **What's stored**: per user, per platform — an access token, a refresh
  token (Facebook long-lived tokens don't truly "refresh" the same way
  Google's do; store per Meta's own token-refresh guidance at submission
  time), the connected Page/Instagram account's id and display name. No
  post content, follower lists, engagement metrics, or any other Graph API
  data is stored — see `social_accounts` in `supabase/migrations/0025_create_social_accounts_and_posts.sql`,
  the same table the YouTube connection already uses (this repo's `provider`
  column would gain `'meta'`/`'instagram'` alongside `'youtube'`).
- **Retention**: tokens are kept only as long as the user's account exists,
  or until they click "Disconnect" in Settings (deletes the row and
  best-effort revokes the token with Meta).
- **Deletion**: account deletion cascades to `social_accounts` (`on delete
  cascade` on `user_id`), same as every other user-owned table in this
  schema.
- **Sharing**: never shared with, or sold to, any third party. Used solely
  to let the account's own owner publish their own content to their own
  connected accounts.

## Demo script (what the required screencast must show, step by step)

1. Start signed out. Sign in (or up) to the app.
2. Open Settings → "Connected accounts" → click "Connect Facebook."
3. Complete the real Facebook OAuth consent screen (a **test Page** and, if
   demoing Instagram too, a **test Instagram Business account** linked to
   it — see prerequisites below) — show the permission-grant screen itself,
   not just a fast-forward past it.
4. Land back in Settings, showing the connected Page/Instagram account by
   name.
5. Go to the Library, pick (or render) a finished reel, click "Post to
   Facebook" (and/or "Post to Instagram").
6. Show the resulting post live on the actual Facebook Page / Instagram
   account — this is the part reviewers are actually checking: that the
   permission produces a real, visible effect on the connected account, not
   just a success toast in this app.
7. Optionally: click "Disconnect" in Settings, show the account no longer
   listed.

## Prerequisites checklist (all external to this repo's code)

- [ ] **Business Verification** completed for the Meta app (Meta Business
      Suite → the app's Business Settings) — required before
      `pages_manage_posts`/`instagram_content_publish` can go from
      Development mode to Live/Advanced Access.
- [ ] A live **Privacy Policy** URL — already exists at `/privacy`; link
      the deployed production URL (e.g. `https://www.myreels.in/privacy`).
- [ ] A live **Terms of Service** URL — already exists at `/terms`
      (`https://www.myreels.in/terms`).
- [ ] A real **test Facebook Page** (any Page the developer account
      administers works for review) and, if demoing Instagram, a **test
      Instagram Business account** linked to that Page.
- [ ] The app's own Facebook Login product configured with a **Valid OAuth
      Redirect URI** pointing at this backend's own callback (mirroring the
      YouTube integration's pattern — see `backend/src/social/client.py`'s
      `get_social_provider`, which would add a `MetaProvider` alongside
      `YouTubeProvider`), **not** Supabase's login callback (same
      "separate OAuth client for a separate purpose" distinction already
      called out for the YouTube client in `DEPLOY.md`).
- [ ] The screencast itself, recorded against the real test Page/IG
      account per the demo script above.

## What's still needed before this can actually be submitted

The connect + publish flow described in "App overview" above is now built:
`MetaProvider` (`backend/src/social/providers/meta_provider.py`, mirroring
`YouTubeProvider`'s shape), registered in `client.py` under the `meta`/
`instagram` provider keys, a "Connect Facebook" button in Settings, and
"Post to Facebook"/"Post to Instagram" next to the existing "Post to
YouTube" one (`PostToSocialButton.tsx`). It has **not** been exercised
against a real Meta app, Page, or Instagram Business account — none were
available while wiring it up (same caveat `youtube_provider.py`'s own file
comment carries for its own resumable upload, before it had a real Google
account to test against).

What's left, all external to this repo's code:

1. Create the Meta app (Meta for Developers), add the Facebook Login
   product, and set `META_APP_ID`/`META_APP_SECRET` per `DEPLOY.md`'s new
   rows for this feature.
2. Complete the prerequisites checklist below (Business Verification, a
   real test Page + linked Instagram Business account, the Valid OAuth
   Redirect URI).
3. Connect a real account through the app's own Settings page and post a
   real reel to both Facebook and Instagram — this is the first real test
   of the code above, not just of the review submission.
4. Record the demo screencast per the script above against that real
   connection.
5. Paste this document's content into Meta's App Review form and submit.

This document (use-case narrative, data handling summary, prerequisites)
is ready to paste into the App Review form as soon as steps 1-4 are done.
