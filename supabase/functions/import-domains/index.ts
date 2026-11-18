import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info, x-supabase-api-version",
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

type LookupResult = {
  domain: string;
  ok: boolean;
  status: number;
  code?: string;
  retry_after_seconds?: number;
  error?: string;
  rdap?: unknown;
  data_source?: string;
};

async function lookupDomain(domain: string): Promise<LookupResult> {
  const apiKey = Deno.env.get("WHOISJSON_API_KEY");

  if (!apiKey) {
    return {
      domain,
      ok: false,
      status: 500,
      code: "CONFIGURATION_ERROR",
      error: "WHOISJSON_API_KEY is missing in Supabase secrets.",
    };
  }

  try {
    const url = new URL("https://whoisjson.com/api/v1/whois");
    url.searchParams.set("domain", domain);

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `TOKEN=${apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(20000),
    });

    // Handle provider errors.
    if (!response.ok) {
      const errorMessages: Record<number, string> = {
        400: "Invalid domain or lookup request.",
        401: "WhoisJSON API key is invalid.",
        403: "WhoisJSON account access is restricted. Check your account.",
        404: "No registration record was found. This does not prove availability.",
        429: "WhoisJSON rate limit reached. Try again later.",
        500: "WhoisJSON service is temporarily unavailable.",
        502: "WhoisJSON service is temporarily unavailable.",
        503: "WhoisJSON service is temporarily unavailable.",
      };

      // Default retry period: 48 hours.
      let retryAfterSeconds = 172800;

      const retryAfterHeader = response.headers.get("Retry-After");

      if (retryAfterHeader) {
        const numericValue = Number(retryAfterHeader);

        if (Number.isFinite(numericValue) && numericValue > 0) {
          retryAfterSeconds = Math.ceil(numericValue);
        } else {
          const retryDate = Date.parse(retryAfterHeader);

          if (!Number.isNaN(retryDate)) {
            retryAfterSeconds = Math.max(
              0,
              Math.ceil((retryDate - Date.now()) / 1000),
            );
          }
        }
      }

      return {
        domain,
        ok: false,
        status: response.status,
        code:
          response.status === 429
            ? "RATE_LIMITED"
            : "LOOKUP_FAILED",
        retry_after_seconds: retryAfterSeconds,
        error:
          errorMessages[response.status] ||
          `WhoisJSON lookup failed (${response.status}).`,
      };
    }

    const data = await response.json();

    // Validate the API response.
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data)
    ) {
      throw new Error("Invalid WHOISJSON response.");
    }

    // Diagnostic information for Supabase logs.
    console.log("WHOISJSON diagnostic:", {
      domain,
      registered: data.registered,
      name: data.name,
      created: data.created,
      expires: data.expires,
      registrar:
        typeof data.registrar === "string"
          ? data.registrar
          : data.registrar?.name,
      responseFields: Object.keys(data),
    });

    // No registration record does not prove availability.
    if (data.registered === false) {
      return {
        domain,
        ok: false,
        status: 404,
        code: "NO_REGISTRATION_RECORD",
        error:
          "No registration record was returned by the lookup provider. This does not prove availability.",
      };
    }

    const registrarName =
      typeof data.registrar === "string"
        ? data.registrar
        : data.registrar?.name || "";

    const rawNameservers = Array.isArray(data.nameserver)
      ? data.nameserver
      : Array.isArray(data.nameservers)
        ? data.nameservers
        : [];

    const nameservers = rawNameservers
      .map((item: unknown) => {
        if (typeof item === "string") {
          return item;
        }

        if (
          item &&
          typeof item === "object" &&
          "name" in item &&
          typeof item.name === "string"
        ) {
          return item.name;
        }

        return "";
      })
      .filter((name: string) => name.length > 0);

    // Convert WHOISJSON response into RDAP-compatible structure.
    const rdap = {
      name: data.name || domain,

      events: [
        ...(data.created
          ? [
              {
                eventAction: "registration",
                eventDate: data.created,
              },
            ]
          : []),

        ...(data.expires
          ? [
              {
                eventAction: "expiration",
                eventDate: data.expires,
              },
            ]
          : []),
      ],

      entities: registrarName
        ? [
            {
              roles: ["registrar"],
              vcardArray: [
                "vcard",
                [["fn", {}, "text", registrarName]],
              ],
            },
          ]
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
      code: "NETWORK_ERROR",
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
      405,
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
        401,
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
      },
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
        401,
      );
    }

    const body = await req.json();
    const domains = body?.domains;

    if (!Array.isArray(domains) || domains.length === 0) {
      return jsonResponse(
        {
          error: "Provide a non-empty domains array.",
        },
        400,
      );
    }

    if (domains.length > 10) {
      return jsonResponse(
        {
          error:
            "Maximum 10 domains per request. Split the import into smaller batches.",
        },
        400,
      );
    }

    const results: LookupResult[] = [];

    for (let i = 0; i < domains.length; i++) {
      const domain = String(domains[i] || "")
        .trim()
        .toLowerCase();

      // Validate domain name.
      const valid =
        /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(
          domain,
        );

      if (!valid) {
        results.push({
          domain,
          ok: false,
          status: 400,
          code: "INVALID_DOMAIN",
          error: "Invalid domain name.",
        });

        continue;
      }

      const result = await lookupDomain(domain);

      results.push(result);

      // Stop all further requests when the rate limit is reached.
      if (result.code === "RATE_LIMITED") {
        console.warn(
          "WHOISJSON rate limit reached. Remaining lookups postponed.",
        );

        for (let j = i + 1; j < domains.length; j++) {
          results.push({
            domain: String(domains[j] || "")
              .trim()
              .toLowerCase(),
            ok: false,
            status: 429,
            code: "RATE_LIMITED",
            retry_after_seconds:
              result.retry_after_seconds || 172800,
            error:
              "Lookup postponed because the WHOISJSON rate limit was reached.",
          });
        }

        break;
      }

      // Wait between requests to reduce provider rate limits.
      if (i < domains.length - 1) {
        await sleep(3500);
      }
    }

    return jsonResponse({
      success: true,
      requested: domains.length,
      successful: results.filter((item) => item.ok).length,
      rate_limited: results.filter(
        (item) => item.code === "RATE_LIMITED",
      ).length,
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
      500,
    );
  }
});
