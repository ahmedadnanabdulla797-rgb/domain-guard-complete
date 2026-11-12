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
  const apiKey = Deno.env.get("WHOISJSON_API_KEY");

  if (!apiKey) {
    return {
      domain,
      ok: false,
      status: 500,
      error: "WHOISJSON_API_KEY is missing in Supabase secrets.",
    };
  }

  try {
    const url = new URL(
      "https://whoisjson.com/api/v1/whois"
    );

    url.searchParams.set("domain", domain);

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `TOKEN=${apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(20000),
    });

    if (!response.ok) {
      const errorMessages: Record<number, string> = {
        400: "Invalid domain or lookup request.",
        401: "WhoisJSON API key is invalid.",
        403: "WhoisJSON account access is restricted. Check your account.",
        404: "No registration record was found. This does not prove availability.",
        429: "WhoisJSON request limit reached. Try again later.",
        500: "WhoisJSON service is temporarily unavailable.",
        502: "WhoisJSON service is temporarily unavailable.",
        503: "WhoisJSON service is temporarily unavailable.",
      };

      return {
        domain,
        ok: false,
        status: response.status,
        error:
          errorMessages[response.status] ||
          `WhoisJSON lookup failed (${response.status}).`,
      };
    }

    const data = await response.json();

    if (data.registered === false) {
      return {
        domain,
        ok: false,
        status: 404,
        error:
          "No registration record was found. Confirm availability with a registrar.",
      };
    }

    const registrarName =
      typeof data.registrar === "string"
        ? data.registrar
        : data.registrar?.name || "";

    const nameservers = Array.isArray(data.nameserver)
      ? data.nameserver
      : Array.isArray(data.nameservers)
        ? data.nameservers
        : [];

    // Convert WhoisJSON response into the RDAP-style
    // structure already used by DomainGuard.
    const rdap = {
      name: data.name || domain,
      events: [
        ...(data.created
          ? [{
              eventAction: "registration",
              eventDate: data.created,
            }]
          : []),
        ...(data.expires
          ? [{
              eventAction: "expiration",
              eventDate: data.expires,
            }]
          : []),
      ],
      entities: registrarName
        ? [{
            roles: ["registrar"],
            vcardArray: [
              "vcard",
              [["fn", {}, "text", registrarName]],
            ],
          }]
        : [],
      nameservers: nameservers.map((name: string) => ({
        ldhName: name,
      })),
      status: Array.isArray(data.status) ? data.status : [],
      port43: "WhoisJSON API",
      rdapConformance: [],
      providerData: data,
    };

    return {
      domain,
      ok: true,
      status: 200,
      rdap,
      data_source: "WhoisJSON",
    };

  } catch (error) {
    console.error("WhoisJSON lookup error:", error);

    return {
      domain,
      ok: false,
      status: 0,
      error:
        error instanceof Error
          ? error.message
          : "Network error during domain lookup.",
    };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders,
    });
  }

  if (req.method !== "POST") {
    return jsonResponse(
      { error: "Method not allowed." },
      405
    );
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const authorization = req.headers.get("Authorization");

    if (!supabaseUrl || !supabaseAnonKey || !authorization) {
      return jsonResponse(
        {
          error:
            "Missing Supabase configuration or authentication.",
        },
        401
      );
    }

    const supabase = createClient(
      supabaseUrl,
      supabaseAnonKey,
      {
        global: {
          headers: {
            Authorization: authorization,
          },
        },
      }
    );

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return jsonResponse(
        {
          error: "Please sign in before importing domains.",
        },
        401
      );
    }

    const body = await req.json();
    const domains = body?.domains;

    if (!Array.isArray(domains) || domains.length === 0) {
      return jsonResponse(
        {
          error: "Provide a non-empty domains array.",
        },
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
      const domain = String(value || "")
        .trim()
        .toLowerCase();

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
