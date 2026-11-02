# D50 Local Music Server

## Legal review changes (2026-11-02)

- R2 recovery writes `songs.status = 'pending_review'` in both the SQL column and JSONB record. Existing rows made by the earlier recovery script with deterministic IDs, matching R2 keys and the placeholder title are also moved to review when `node rebuild-database.js --apply` runs again. The Master Admin's **Free Uploads** queue can preview and approve these rows. Public `/api/songs` returns only `approved` rows. Restart the Render service after running the script because D50 caches songs at startup. R2 objects themselves have public URLs, so review status hides tracks from D50 listings but does not revoke access to anyone who already knows an R2 URL.
- The home footer links to `public/legal/terms.html`, `privacy.html`, and `affiliate.html`. Their visible drafting notes **must be completed** with the operator's legal identity, contact details, privacy retention and legal bases, and reviewed before publication. These pages are drafts, not a legal certification.
- Premium is presented as a **one-time 30-day pass** (36.00 DKK or 28.80 DKK with an approved creator code). The server checks the regular Stripe Payment Link's one-time 36 DKK price before returning it. If that check fails, the checkout is blocked until the Stripe price is corrected. The affiliate Checkout Session already requires a one-time 28.80 DKK price. D50 does not create recurring Stripe subscriptions. Previously displayed Auto-Pay wording was inaccurate and has been removed. The old cancellation API responds that there is no recurring payment to cancel. Confirm your actual Stripe dashboard product and Payment Link settings before selling.

## R2 upload configuration

Set `R2_BUCKET_NAME`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_DEV_URL` in the **same Render web service** that runs D50, then redeploy. `R2_DEV_URL` is the complete HTTPS public bucket address such as `https://pub-<bucket-id>.r2.dev`, not `https://r2.dev` and not the S3 API endpoint. If an upload returns `R2_NOT_CONFIGURED`, the response and Render startup logs identify the missing or invalid variable **by name only**, without printing credentials. Existing `CLOUDINARY_` settings do not control R2 uploads.

Set `D50_ADMIN_MASTER_PIN` in the same Render service; the master PIN has no hardcoded fallback. After three wrong attempts an account must wait 15 minutes. Entering the correct PIN after the freeze clears its failed-attempt counter. Never share the PIN or put it in GitHub; change it in Render if it was exposed.

## Restore an empty PostgreSQL database from R2

Deploy this project with `rebuild-database.js` in the project root. In **Render → D50-music → Shell**, run `node rebuild-database.js` first to preview the discovered objects and any cover matches. If they look right, run `node rebuild-database.js --apply` once, then restart the Render service to reload its in-memory song and category catalogs. Render must have `DATABASE_URL`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, and the full public `R2_DEV_URL` configured. Do not paste their values into the script or a support message.

The script scans `audio/` (the folder this version of D50 writes), legacy `songs/`, and `covers/`. It does not download or delete media, overwrite existing songs, or recover titles, likes, original song IDs, or category assignments that were only in the lost database. It creates `pending_review` tracks with placeholder metadata and a **Trending AI Hits** category. Audio and cover upload filenames use different random UUIDs, so covers are attached only when the stem matches or a unique same-owner timestamp match falls within ten seconds; check the preview before applying. Unmatched covers remain unassigned. Re-running the script skips existing tracks or moves earlier restored placeholder tracks into review.

## Install D50 Music on a phone

D50 is configured as a Progressive Web App and opens in standalone mode after installation.

- Android/Chrome: open the live HTTPS site, open the browser menu, and choose **Install app** or **Add to Home screen**.
- iPhone/Safari: open the live HTTPS site, tap **Share**, choose **Add to Home Screen**, and confirm **D50 Music**.

The dashboard app shell is cached after the first successful visit so the interface starts quickly on later launches and remains available during a weak connection. Live account, song, and payment data still require a network connection.

## Affiliate referral setup

Master admin approves a unique creator code inside D50. The buyer enters it in D50's Premium popup; Stripe receives the 28.80 DKK price directly. Approving new creators does not create Stripe coupons or promotion codes. Previously approved creators continue to work with their existing D50 codes.

## Premium checkout with a creator code

The Upgrade to Premium popup offers normal 36 DKK checkout or an optional creator code. An approved creator code opens a Stripe Checkout Session priced directly at 28.80 DKK, with no coupon displayed or entered on Stripe. `STRIPE_AFFILIATE_PRICE_ID` accepts either the `prod_...` ID of the 28.80 DKK product in Stripe (uses its default price) or its `price_...` ID. Without this setting, D50 finds a unique active, one-time 28.80 DKK price on a product named **D50 Premium** automatically. If no unique price is found and `STRIPE_PAYMENT_LINK_ID` is configured, D50 creates a 28.80 DKK checkout price on the existing 36 DKK Premium product. The regular 36 DKK checkout still uses its Payment Link. Checkout return URLs use `APP_BASE_URL`; on Render, D50 can also use the live HTTPS `.onrender.com` host. The webhook grants Premium and counts one referral after paid checkout. The server rejects inactive codes, self-referrals, and a configured affiliate price that is not 28.80 DKK.

The master admin hub also shows **Money made**, calculated from paid Stripe Checkout Sessions for the configured personal and extra-slot Payment Link IDs and D50's creator-code checkouts. It shows gross checkout amounts for all time and the last 30 days, grouped by currency. These numbers include payments later refunded and exclude Stripe fees, taxes owed, and non-D50 payments. The panel requires `STRIPE_SECRET_KEY` and at least one configured Payment Link ID. It reads Stripe live when opened and may take longer for accounts with many Checkout Sessions.

The existing Stripe webhook must continue sending `checkout.session.completed` events to `/webhook`. An affiliate receives **+1 referral** only after a successful personal-plan checkout grants the buyer the full **30 days of Premium**. Extra-slot purchases, self-referrals, duplicate webhook deliveries, and payments that cannot be matched to a D50 user do not count. D50 records each qualifying paid Checkout Session at most once, so Stripe webhook retries cannot increase the counter twice.

Master Admin sees approved creators, their codes, and referral counts under **Affiliate Applications Queue**. **Delete code & reset count** removes the code from the creator's D50 account and sets the count to zero. For older creators with Stripe Promotion Codes, it deactivates the code in Stripe first. Past payments remain in payment history. The creator can submit a new application later.

After approval, the creator sees **You're now a D50 partner!** with their code, a Copy code button, and a live referral count. The Partner shortcut opens this view later; account status refreshes while the app is open and on return to the tab.

Liking a song saves it in **Your library** immediately, including songs beyond the first catalog page. The library loads all saved songs for the signed-in account from `/api/library/songs`. As before, an uploader's own song Like saves the track privately without adding to its public Like count. Category counting is unchanged.

## Report a song

Click **Report**, then click the song on the page. The report popup opens with that song selected, ready for a reason and submission.
The song's Play button still plays normally during selection mode and exits it. Click **Cancel report** or press Escape to leave selection mode.

## Cloudflare R2 media storage


D50 stores new audio files, song artwork, and category artwork in the `d50-music-vault` R2 bucket. Configure these Render environment variables:

- `R2_BUCKET_NAME=d50-music-vault`
- `R2_ACCOUNT_ID=769eda3d70aa850f0dd58e92bb76a74d`
- `R2_ACCESS_KEY_ID` — from a bucket-scoped Object Read & Write token
- `R2_SECRET_ACCESS_KEY` — store only in Render
- `R2_DEV_URL` — the bucket's complete public development URL, such as `https://pub-abc123.r2.dev`

The generic `https://r2.dev` address is not a bucket URL and is rejected. In Cloudflare, open the bucket, choose **Settings**, enable the public development URL, and copy the complete `pub-….r2.dev` value. Existing songs whose database URLs point to Cloudinary must be copied into R2 and have their song records updated before the old Cloudinary account is disabled.

Only if the database still contains song records pointing to working legacy Cloudinary files, you can use the separate media migration after configuring R2:

```sh
npm run migrate:r2
```

The migration copies existing audio and artwork into R2 and rewrites the PostgreSQL song/category records. Confirm that old and new tracks play from the `pub-….r2.dev` host before removing the old Cloudinary environment variables or account.

Until every saved song URL is migrated, the app permits playback and artwork from legacy `res.cloudinary.com` URLs. If the old Cloudinary assets were deleted or disabled, this permission cannot restore the files: restore access to the old assets and rerun `npm run migrate:r2`, or reupload the tracks. A Cloudflare R2 URL returning 403/404 means the object or public bucket URL needs repair. The current distribution ZIP omits local `data/` and `music/` so it cannot overwrite repository data; inspect the live PostgreSQL records for existing song URLs.

If a song remains at 0:00, the player says when its audio file cannot load and logs the saved URL in the browser console. The normal playback and Like requests retain the behavior of the supplied working Cloudinary version. Admin pending-track previews use a separate audio player, so opening or closing a preview cannot replace the main player's song. Failed Like and Listen network requests display an error rather than silently failing.

## Start on Windows

1. Install Node.js LTS from https://nodejs.org
2. Extract this folder.
3. Open the extracted `D50-local` folder in File Explorer.
4. Click the address bar, type `cmd`, and press Enter.
5. Run `npm install`
6. Run `npm start`
7. Open http://localhost:5050

Keep the command window open while using D50. Uploaded MP3, WAV, and M4A files are permanently stored in the `music` folder. Song information is stored in `data/songs.json`, and accounts are stored in `data/users.json`.

The app opens directly in Guest mode. Each browser receives five guest song plays, saved locally in that browser. Attempting a sixth play opens the Login/Create Account gate over the blurred dashboard. The first account you create becomes the D50 owner and can delete any uploaded song. Signed-in free accounts retain the five-play Premium limit. The mock card screen is for testing only and never charges real money.

This local version listens only on your PC (`127.0.0.1`) for safety. Do not expose it to the internet yet. Account sessions are stored locally and survive a Node.js server restart. This is a local prototype, not a production payment system.
