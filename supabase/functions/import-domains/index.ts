import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function lookupDomain(domain: string) {
  const url = `https://rdap.org/domain/${encodeURIComponent(domain)}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/rdap+json, application/json",
          "User-Agent": "DomainGuard/1.0",
        },
      });

      if (response.status === 404) {
        return {
          domain,
          ok: false,
          status: 404,
          error:
            "No RDAP registration record found. This does not prove availability.",
        };
      }

      if (response.status === 429 || response.status >= 500) {
        if (attempt < 2) {
          const retryAfter = Number(
            response.headers.get("Retry-After")
          );

          const delay =
            Number.isFinite(retryAfter) && retryAfter > 0
              ? Math.min(retryAfter * 1000, 10000)
              : 2000 * (attempt + 1);

          await sleep(delay);
          continue;
        }
      }

      if (!response.ok) {
        return {
          domain,
          ok: false,
          status: response.status,
          error: `RDAP lookup failed (${response.status}).`,
        };
      }

      const rdap = await response.json();

      return {
        domain,
        ok: true,
        status: 200,
        rdap: {
          events: rdap.events || [],
          entities: rdap.entities || [],
          nameservers: rdap.nameservers || [],
          status: rdap.status || [],
          port43: rdap.port43 || null,
          rdapConformance: rdap.rdapConformance || [],
        },
      };
    } catch (error) {
      if (attempt < 2) {
        await sleep(2000 * (attempt + 1));
        continue;
      }

      return {
        domain,
        ok: false,
        status: 0,
        error:
          error instanceof Error ? error.message : "Network error",
      };
    }
  }

  return {
    domain,
    ok: false,
    status: 429,
    error: "RDAP rate limit reached. Try again later.",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const authorization = req.headers.get("Authorization");

    if (!supabaseUrl || !supabaseAnonKey || !authorization) {
      return jsonResponse(
        { error: "Missing Supabase configuration or authentication." },
        401
      );
    }

    const supabase = createClient(
      supabaseUrl,
      supabaseAnonKey,
      {
        global: {
          headers: { Authorization: authorization },
        },
      }
    );

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return jsonResponse(
        { error: "Please sign in before importing domains." },
        401
      );
    }

    const body = await req.json();
    const domains = body?.domains;

    if (!Array.isArray(domains) || domains.length === 0) {
      return jsonResponse(
        { error: "Provide a non-empty domains array." },
        400
      );
    }

    if (domains.length > 10) {
      return jsonResponse(
        {
          error:
            "Maximum 10 domains per request. Split the import into smaller batches.",
        },
        400
      );
    }

    const results = [];

    for (const value of domains) {
      const domain = String(value || "").trim().toLowerCase();

      const valid =
        /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
          domain
        );

      if (!valid) {
        results.push({
          domain,
          ok: false,
          status: 400,
          error: "Invalid domain name.",
        });
        continue;
      }

      results.push(await lookupDomain(domain));

      if (results.length < domains.length) {
        await sleep(1200);
      }
    }

    return jsonResponse({
      success: true,
      requested: domains.length,
      successful: results.filter((item) => item.ok).length,
      results,
    });
  } catch (error) {
    console.error("Import domains error:", error);

    return jsonResponse(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unexpected server error.",
      },
      500
    );
  }
});