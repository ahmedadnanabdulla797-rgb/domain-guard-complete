# DomainGuard — Domain Monitoring Platform (v3.0)

This project builds on the supplied DomainGuard UI and replaces simulated behavior with a real Supabase-backed application. It includes a responsive dashboard, real email/password authentication, per-user domain storage, RDAP lookup, expiry calendar, portfolios, alert history, CSV import/export, theme persistence, and Supabase Edge Functions for notification tests and scheduled domain checks.

## Important: services must be configured

The source code is ready to configure, but I cannot connect it to your private Supabase project or verify live email/Telegram delivery without your project credentials and deployment. Do not paste service-role keys, Resend keys, or Telegram bot tokens into the frontend.

## 1. Configure Supabase

1. Create/open your Supabase project.
2. In **SQL Editor**, run `supabase/schema.sql`.
3. Open **Project Settings → API** and copy the project URL and publishable/anon key.
4. Edit `config.js` and replace `YOUR_PROJECT_ID` and `YOUR_SUPABASE_ANON_OR_PUBLISHABLE_KEY`.
5. In **Authentication → URL Configuration**, add your local and production website URLs to Site URL / Redirect URLs. For example, add your Cloudflare Pages URL and local development URL.
6. If email confirmation is enabled, confirm the email address after sign-up.

The browser key is expected to be public; Row Level Security is enabled on user-owned tables. Never put the `service_role` key in `config.js`.

## 2. Run locally

This is a static frontend. Use a local HTTP server instead of opening `index.html` with a `file://` URL.

With Python installed, open a terminal in this folder and run:

```bash
python -m http.server 8080
```

Then open `http://localhost:8080`.

You can also use VS Code Live Server.

## 3. Deploy the frontend to Cloudflare Pages

For a static upload, deploy these files at the site root:

- `index.html`
- `styles.css`
- `app.js`
- `config.js`

For a Git-connected Pages project, push the folder to your repository and use the folder as the project root. No build command is required. The static output directory is `.`.

## 4. Configure server-side notification secrets

Install the Supabase CLI and log in, then link this folder to your project. Deploy the two functions:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy test-notifications
supabase functions deploy monitor-domains --no-verify-jwt
```

`monitor-domains` is protected by its own `x-cron-secret` header. Do not expose this secret to the browser.

Set these secrets in Supabase Edge Function secrets / project secrets:

- `CRON_SECRET` — long random secret used only by your scheduler.
- `RESEND_API_KEY` — Resend API key.
- `RESEND_FROM_EMAIL` — verified sender, e.g. `DomainGuard <alerts@your-verified-domain.com>`.
- `TELEGRAM_BOT_TOKEN` — token from BotFather.

Supabase provides `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` to Edge Functions. If your project/runtime does not expose them automatically, configure them as function secrets. The service-role key must only be available server-side.

Example CLI secret setup (replace the values locally; never commit them):

```bash
supabase secrets set CRON_SECRET="YOUR_LONG_RANDOM_SECRET" RESEND_API_KEY="re_..." RESEND_FROM_EMAIL="DomainGuard <alerts@your-verified-domain.com>" TELEGRAM_BOT_TOKEN="123456:your-bot-token"
```

Verify your sender domain in Resend before expecting email delivery. Users must start a Telegram chat with the bot before the bot can message them. The website stores each user's Telegram chat ID, not their bot token.

## 5. Schedule the monitoring function

The `monitor-domains` function checks domains whose `next_check_at` is due, retrieves RDAP data when available, updates the domain record, creates deduplicated expiry alerts for configured thresholds, and attempts email/Telegram delivery. Failed checks are rescheduled for retry; they are not treated as proof that a domain is available.

Recommended: use Supabase Cron to invoke the function once per hour. For example, in SQL Editor (ensure `pg_cron`, `pg_net`, and Vault are available in your project), store the URL and secret in Vault first:

```sql
select vault.create_secret('https://YOUR_PROJECT_REF.supabase.co/functions/v1/monitor-domains', 'domain_guard_monitor_url');
select vault.create_secret('YOUR_LONG_RANDOM_SECRET', 'domain_guard_cron_secret');
```

Then schedule it:

```sql
select cron.schedule(
  'domain-guard-monitor-hourly',
  '15 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'domain_guard_monitor_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'domain_guard_cron_secret')
    ),
    body := jsonb_build_object('source', 'supabase-cron')
  );
  $$
);
```

If your project doesn't have the Vault/pg_net extensions available, use the Supabase Dashboard's supported scheduled-function mechanism or another trusted scheduler to POST to the function URL with the `x-cron-secret` header. Keep the secret out of client-side code and repositories.

Newly added domains are scheduled for a check. Until the scheduled function runs successfully, registration fields may be blank and the UI intentionally displays them as unknown.

## 6. Test notifications

1. Sign into the website.
2. Open **Integrations**.
3. Set the email recipient and/or Telegram chat ID, enable the channel, and save settings.
4. Click **Send test email** or **Send test message**.
5. If it fails, inspect the Edge Function logs and confirm the provider secret and sender/chat setup.

Email and Telegram credentials are server-side secrets; they are never entered into the website. Test sends create delivery log records only after provider success/failure is known.

## 7. What is implemented

- Supabase email/password sign-up, sign-in, password reset, session persistence, and sign-out.
- User-isolated database records protected by RLS.
- Domain create/delete and duplicate validation.
- Real RDAP finder with no synthetic/fabricated fallback values.
- Registration date, expiry date, registrar, status codes and nameservers where RDAP returns them.
- Dashboard metrics calculated from database records.
- Expiry calendar, portfolio grouping, alert center, unread state, CSV import/export, light/dark mode.
- Notification preferences and real Edge Function test-send flows.
- Scheduled RDAP checks and threshold-based expiry reminders with deduplication.
- Delivery logs for email and Telegram sends.

## 8. Known limitations / next production hardening

- RDAP fields and support differ by TLD. Missing expiry dates are shown as unknown; lookup failure does not mean a domain is available.
- Public RDAP does not reliably expose registrar auto-renew settings. The application does not claim to verify auto-renewal.
- This version does not yet include enterprise organization/team sharing, DNS history monitoring, TLS certificate monitoring, billing, or registrar account integrations. These need separate schemas/providers and must not be represented as active features until implemented.
- The calendar lists known expiry dates, and reminders run on the scheduled backend. Ensure your scheduler is enabled and monitor function logs.
- Review Supabase Auth email templates, allowed redirect URLs, provider rate limits, retention, backup, and alert-delivery monitoring before production use.
- For a production deployment, restrict function CORS origins to your actual website domain and consider stronger account verification and per-user rate limits.

## Troubleshooting

- **Setup required on the dashboard:** Check `config.js`, redeploy the static files, and hard refresh the page.
- **Sign-in redirects / email links fail:** Add your website domain to Supabase Auth redirect allow-list.
- **Permission denied:** Confirm `supabase/schema.sql` was run and you are signed in as the record owner.
- **RDAP lookup unavailable:** Some TLDs lack public RDAP coverage, providers can rate-limit requests, and browser connectivity can fail. Retry or configure a commercial domain-data provider for higher coverage.
- **Email test fails:** Verify Resend API key, sender domain, recipient, and `RESEND_FROM_EMAIL` secret.
- **Telegram test fails:** Ensure the bot token is correct, the user has started the bot, the chat ID is correct, and `telegram_enabled` is saved.
- **Reminders don't arrive:** Confirm the scheduled function is running, `CRON_SECRET` matches Vault/scheduler, the domain's `next_check_at` is due, a reminder threshold matches, and a channel is enabled.
