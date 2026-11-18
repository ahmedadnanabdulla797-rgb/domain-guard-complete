```typescript
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const json = (
  body: unknown,
  status = 200
) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  }
});

const dateOnly = (value?: string) => {
  if (!value) return null;

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return null;

  return date.toISOString().slice(0, 10);
};

const daysUntil = (value: string) => {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const expiry = new Date(`${value}T00:00:00.000Z`);

  return Math.ceil(
    (expiry.getTime() - today.getTime()) / 86400000
  );
};

function registrarFromRdap(data: any) {
  const entity = (data.entities || []).find(
    (e: any) => (e.roles || []).includes('registrar')
  );

  const vcard = entity?.vcardArray?.[1] || [];

  return (
    vcard.find((r: any[]) => r[0] === 'fn')?.[3] ||
    vcard.find((r: any[]) => r[0] === 'org')?.[3] ||
    null
  );
}

function escapeHtml(input: string) {
  return input.replace(
    /[&<>"']/g,
    (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[c] as string)
  );
}

function getRetrySeconds(response: Response): number {
  const header = response.headers.get('Retry-After');

  // Default: 48 hours.
  if (!header) return 172800;

  const numericValue = Number(header);

  if (Number.isFinite(numericValue) && numericValue > 0) {
    return Math.ceil(numericValue);
  }

  const retryDate = Date.parse(header);

  if (!Number.isNaN(retryDate)) {
    return Math.max(
      60,
      Math.ceil((retryDate - Date.now()) / 1000)
    );
  }

  return 172800;
}

async function sendChannels(
  admin: any,
  ownerId: string,
  domain: any,
  alert: any,
  prefs: any
) {
  if (
    prefs?.email_enabled &&
    prefs?.email_recipient &&
    Deno.env.get('RESEND_API_KEY') &&
    Deno.env.get('RESEND_FROM_EMAIL')
  ) {
    const recipient = prefs.email_recipient;

    try {
      const response = await fetch(
        'https://api.resend.com/emails',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${Deno.env.get('RESEND_API_KEY')}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: Deno.env.get('RESEND_FROM_EMAIL'),
            to: [recipient],
            subject: alert.title,
            html: `
              <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#172033">
                <div style="font-size:12px;letter-spacing:1px;color:#2463eb;font-weight:bold">
                  DOMAIN GUARD
                </div>
                <h2>${escapeHtml(alert.title)}</h2>
                <p>${escapeHtml(alert.message)}</p>
                <table style="border-collapse:collapse;width:100%;font-size:14px">
                  <tr>
                    <td style="padding:10px;border-bottom:1px solid #ddd;color:#64748b">
                      Domain
                    </td>
                    <td style="padding:10px;border-bottom:1px solid #ddd;font-weight:bold">
                      ${escapeHtml(domain.domain_name)}
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:10px;border-bottom:1px solid #ddd;color:#64748b">
                      Expiration
                    </td>
                    <td style="padding:10px;border-bottom:1px solid #ddd">
                      ${domain.expiration_date || 'Unknown'}
                    </td>
                  </tr>
                </table>
                <p style="font-size:12px;color:#64748b">
                  Verify renewal status directly with your registrar.
                  RDAP data may be delayed or incomplete.
                </p>
              </div>
            `
          })
        }
      );

      const result = await response.json().catch(() => ({}));

      await admin.from('notification_deliveries').insert({
        owner_id: ownerId,
        alert_id: alert.id,
        domain_id: domain.id,
        channel: 'email',
        recipient,
        status: response.ok ? 'delivered' : 'failed',
        provider_id: result.id || null,
        error_message: response.ok
          ? null
          : (result.message || 'Email provider error')
      });

    } catch (e) {
      await admin.from('notification_deliveries').insert({
        owner_id: ownerId,
        alert_id: alert.id,
        domain_id: domain.id,
        channel: 'email',
        recipient,
        status: 'failed',
        error_message: String(e).slice(0, 500)
      });
    }
  }

  if (
    prefs?.telegram_enabled &&
    prefs?.telegram_chat_id &&
    Deno.env.get('TELEGRAM_BOT_TOKEN')
  ) {
    const recipient = String(prefs.telegram_chat_id);

    try {
      const response = await fetch(
        `https://api.telegram.org/bot${Deno.env.get('TELEGRAM_BOT_TOKEN')}/sendMessage`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            chat_id: recipient,
            text:
              `DOMAIN GUARD ALERT\n\n${alert.title}\n` +
              `Domain: ${domain.domain_name}\n` +
              `Expiration: ${domain.expiration_date || 'Unknown'}\n\n` +
              `${alert.message}\n\n` +
              `Verify renewal status with your registrar.`
          })
        }
      );

      const result = await response.json().catch(() => ({}));

      const ok = response.ok && result.ok;

      await admin.from('notification_deliveries').insert({
        owner_id: ownerId,
        alert_id: alert.id,
        domain_id: domain.id,
        channel: 'telegram',
        recipient,
        status: ok ? 'delivered' : 'failed',
        provider_id: result.result?.message_id
          ? String(result.result.message_id)
          : null,
        error_message: ok
          ? null
          : (result.description || 'Telegram API error')
      });

    } catch (e) {
      await admin.from('notification_deliveries').insert({
        owner_id: ownerId,
        alert_id: alert.id,
        domain_id: domain.id,
        channel: 'telegram',
        recipient,
        status: 'failed',
        error_message: String(e).slice(0, 500)
      });
    }
  }
}

Deno.serve(async (req) => {

  // Scheduler authentication.
  const secret = Deno.env.get('CRON_SECRET');

  if (
    !secret ||
    req.headers.get('x-cron-secret') !== secret
  ) {
    return json({
      error: 'Unauthorized scheduler request.'
    }, 401);
  }

  const url = Deno.env.get('SUPABASE_URL') ?? '';

  const serviceKey = Deno.env.get(
    'SUPABASE_SERVICE_ROLE_KEY'
  ) ?? '';

  if (!url || !serviceKey) {
    return json({
      error: 'Supabase server configuration is incomplete.'
    }, 500);
  }

  const admin = createClient(url, serviceKey);

  const now = new Date().toISOString();

  const {
    data: domains,
    error
  } = await admin
    .from('domains')
    .select('*')
    .lte('next_check_at', now)
    .order('next_check_at')
    .limit(100);

  if (error) {
    return json({
      error: error.message
    }, 500);
  }

  let checked = 0;
  let failed = 0;
  let alertsCreated = 0;
  let rateLimited = false;
  let postponed = 0;

  const errors: string[] = [];

  for (let i = 0; i < (domains || []).length; i++) {

    const domain = domains![i];

    try {

      const apiKey = Deno.env.get('WHOISJSON_API_KEY');

      if (!apiKey) {
        throw new Error(
          'WHOISJSON_API_KEY is missing in Supabase secrets.'
        );
      }

      const lookupUrl = new URL(
        'https://whoisjson.com/api/v1/whois'
      );

      lookupUrl.searchParams.set(
        'domain',
        domain.domain_name
      );

      const controller = new AbortController();

      const timeout = setTimeout(
        () => controller.abort(),
        20000
      );

      let response: Response;

      try {
        response = await fetch(
          lookupUrl.toString(),
          {
            method: 'GET',
            headers: {
              Authorization: `TOKEN=${apiKey}`,
              Accept: 'application/json'
            },
            signal: controller.signal
          }
        );
      } finally {
        clearTimeout(timeout);
      }

      // ==========================================
      // WHOISJSON RATE-LIMIT PROTECTION
      // ==========================================

      if (response.status === 429) {

        const retryAfterSeconds = getRetrySeconds(response);

        const retryAt = new Date(
          Date.now() + retryAfterSeconds * 1000
        ).toISOString();

        console.warn(
          'WHOISJSON rate limit reached. Postponing remaining domains until:',
          retryAt
        );

        const remainingDomains = domains!.slice(i);

        const { error: scheduleError } = await admin
          .from('domains')
          .update({
            next_check_at: retryAt
          })
          .in(
            'id',
            remainingDomains.map((d: any) => d.id)
          );

        if (scheduleError) {
          errors.push(
            `Could not postpone domains: ${scheduleError.message}`
          );
        } else {
          postponed = remainingDomains.length;
        }

        rateLimited = true;

        break;
      }

      if (!response.ok) {
        throw new Error(
          `WhoisJSON lookup failed: HTTP ${response.status}.`
        );
      }

      const data = await response.json();

      if (
        !data ||
        typeof data !== 'object' ||
        Array.isArray(data)
      ) {
        throw new Error(
          'Invalid WhoisJSON response.'
        );
      }

      if (data.registered === false) {
        throw new Error(
          'No registration record found. This does not prove domain availability.'
        );
      }

      const reg = data.created
        ? dateOnly(data.created)
        : null;

      const exp = data.expires
        ? dateOnly(data.expires)
        : null;

      const registrarName =
        typeof data.registrar === 'string'
          ? data.registrar
          : data.registrar?.name || null;

      const rawNameservers = Array.isArray(data.nameserver)
        ? data.nameserver
        : Array.isArray(data.nameservers)
          ? data.nameservers
          : [];

      const nameservers = rawNameservers
        .map((item: any) =>
          typeof item === 'string'
            ? item
            : item?.name || ''
        )
        .filter(Boolean);

      const statusCodes = Array.isArray(data.status)
        ? data.status
        : [];

      // ==========================================
      // UPDATE DOMAIN INFORMATION
      // ==========================================

      const update: Record<string, unknown> = {

        registrar_name:
          registrarName || domain.registrar_name,

        registration_date:
          reg || domain.registration_date,

        expiration_date:
          exp || domain.expiration_date,

        nameservers:
          nameservers.length
            ? nameservers
            : domain.nameservers,

        status_codes: statusCodes,

        domain_status:
          statusCodes.join(', ') ||
          domain.domain_status ||
          'registered',

        data_source: 'WhoisJSON',

        last_checked_at: now,

        next_check_at: new Date(
          Date.now() + 24 * 60 * 60 * 1000
        ).toISOString(),

        last_check_error: null
      };

      const {
        error: updateError
      } = await admin
        .from('domains')
        .update(update)
        .eq('id', domain.id);

      if (updateError) {
        throw updateError;
      }

      checked++;

      // ==========================================
      // EXPIRATION ALERTS
      // ==========================================

      const effectiveExpiry =
        exp || domain.expiration_date;

      if (!effectiveExpiry) {
        continue;
      }

      const remaining = daysUntil(effectiveExpiry);

      const {
        data: prefs
      } = await admin
        .from('notification_preferences')
        .select('*')
        .eq('user_id', domain.owner_id)
        .maybeSingle();

      const thresholds: number[] =
        prefs?.notify_days_before ||
        [30, 14, 7, 3, 1, 0];

      const matched = thresholds.includes(remaining);

      if (matched) {

        const title =
          remaining < 0
            ? `Domain expired: ${domain.domain_name}`
            : remaining === 0
              ? `Domain expires today: ${domain.domain_name}`
              : `Domain expires in ${remaining} day${remaining === 1 ? '' : 's'}: ${domain.domain_name}`;

        const message =
          remaining < 0
            ? `The last known expiration date was ${effectiveExpiry}. Check the registrar immediately; registry grace and redemption periods vary.`
            : remaining === 0
              ? `The last known expiration date is today (${effectiveExpiry}). Verify renewal status with the registrar.`
              : `The last known expiration date is ${effectiveExpiry}. Plan renewal before the date.`;

        const dedupeKey =
          `${domain.id}:expiry:${effectiveExpiry}:${remaining}`;

        const {
          data: alert,
          error: alertError
        } = await admin
          .from('alerts')
          .insert({
            owner_id: domain.owner_id,
            domain_id: domain.id,
            domain_name: domain.domain_name,
            alert_type: 'expiry',
            severity: remaining <= 7
              ? 'critical'
              : 'warning',
            title,
            message,
            dedupe_key: dedupeKey
          })
          .select()
          .maybeSingle();

        if (!alertError && alert) {

          alertsCreated++;

          await sendChannels(
            admin,
            domain.owner_id,
            {
              ...domain,
              expiration_date: effectiveExpiry
            },
            alert,
            prefs
          );

        } else if (
          alertError &&
          !String(alertError.message)
            .toLowerCase()
            .includes('duplicate')
        ) {
          errors.push(
            `Alert for ${domain.domain_name}: ${alertError.message}`
          );
        }
      }

    } catch (e) {

      failed++;

      const message = String(
        (e as Error)?.message || e
      ).slice(0, 500);

      errors.push(
        `${domain.domain_name}: ${message}`
      );

      await admin
        .from('domains')
        .update({
          last_check_error: message,
          next_check_at: new Date(
            Date.now() + 6 * 60 * 60 * 1000
          ).toISOString()
        })
        .eq('id', domain.id);
    }
  }

  return json({
    ok: true,
    due: domains?.length || 0,
    checked,
    failed,
    alertsCreated,
    rateLimited,
    postponed,
    errors: errors.slice(0, 20),
    completedAt: new Date().toISOString()
  });

});
```
