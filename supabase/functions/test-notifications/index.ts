import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Sign in is required.' }, 401);
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const anon = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) return json({ error: 'Invalid session.' }, 401);
  const admin = createClient(url, serviceKey);
  const { data: prefs, error: prefError } = await admin.from('notification_preferences').select('*').eq('user_id', userData.user.id).maybeSingle();
  if (prefError) return json({ error: 'Could not read notification settings.' }, 500);
  let body: { channel?: string } = {};
  try { body = await req.json(); } catch { return json({ error: 'Invalid request body.' }, 400); }
  const channel = body.channel;
  if (channel === 'email') {
    if (!prefs?.email_enabled || !prefs?.email_recipient) return json({ error: 'Enable email alerts and save a recipient first.' }, 400);
    const apiKey = Deno.env.get('RESEND_API_KEY');
    const from = Deno.env.get('RESEND_FROM_EMAIL');
    if (!apiKey || !from) return json({ error: 'Email service is not configured. Add RESEND_API_KEY and RESEND_FROM_EMAIL as Edge Function secrets.' }, 503);
    const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to: [prefs.email_recipient], subject: 'DomainGuard test notification', html: '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto"><h2>DomainGuard email test</h2><p>Your email notification channel is configured. This is a test message; no domain action is required.</p><p style="color:#64748b;font-size:12px">DomainGuard · Domain lifecycle monitoring</p></div>' }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return json({ error: payload.message || 'Email provider rejected the test message.' }, 502);
    await admin.from('notification_deliveries').insert({ owner_id: userData.user.id, channel: 'email', recipient: prefs.email_recipient, status: 'delivered', provider_id: payload.id || null });
    return json({ message: `Test email accepted by Resend for ${prefs.email_recipient}.` });
  }
  if (channel === 'telegram') {
    if (!prefs?.telegram_enabled || !prefs?.telegram_chat_id) return json({ error: 'Enable Telegram alerts and save a chat ID first.' }, 400);
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    if (!token) return json({ error: 'Telegram is not configured. Add TELEGRAM_BOT_TOKEN as an Edge Function secret.' }, 503);
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: prefs.telegram_chat_id, text: 'DomainGuard test notification\n\nYour Telegram alert channel is configured. This is a test message; no domain action is required.' }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) return json({ error: payload.description || 'Telegram rejected the test message. Start a chat with your bot and verify the chat ID.' }, 502);
    await admin.from('notification_deliveries').insert({ owner_id: userData.user.id, channel: 'telegram', recipient: prefs.telegram_chat_id, status: 'delivered', provider_id: String(payload.result?.message_id || '') || null });
    return json({ message: 'Telegram test message delivered.' });
  }
  return json({ error: 'channel must be email or telegram.' }, 400);

  function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }); }
});
function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }); }
