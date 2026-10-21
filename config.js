/* Public frontend configuration only.
 * Supabase anon/publishable keys are designed for browser use when RLS is configured.
 * NEVER put service-role, Resend, Telegram bot, or other secret keys in this file.
 */
window.DOMAIN_GUARD_CONFIG = {
  SUPABASE_URL: "https://YOUR_PROJECT_ID.supabase.co",
  SUPABASE_ANON_KEY: "YOUR_SUPABASE_ANON_OR_PUBLISHABLE_KEY"
};
