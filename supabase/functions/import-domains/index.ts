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

function getRetryAfter(response: Response): number {
  const header = response.headers.get("Retry-After");

  if (!header) return 172800;

  const numericValue = Number(header);

  if (Number.isFinite(numericValue) && numericValue > 0) {
    return Math.max(60, Math.ceil(numericValue));
  }

  const retryDate = Date.parse(header);

  if (!Number.isNaN(retryDate)) {
    return Math.max(
      60,
      Math.ceil((retryDate - Date.now()) / 1000),
    );
  }

  return 172800;
}

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

    if (!response.ok) {
      if (response.status === 429) {
        return {
          domain,
          ok: false,
          status: 429,
          code: "RATE_LIMITED",
          retry_after_seconds: getRetryAfter(response),
          error: "WHOISJSON request limit reached. Lookup postponed.",
        };
      }

      if (response.status === 404) {
        return {
          domain,
          ok: false,
          status: 404,
          code: "NO_REGISTRATION_RECORD",
          error:
            "No registration record was returned. This does not prove domain availability.",
        };
      }

      const errorMessages: Record<number, string> = {
        400: "Invalid domain or lookup request.",
        401: "WHOISJSON API key is invalid.",
        403: "WHOISJSON account access is restricted. Check your account.",
        500: "WHOISJSON service is temporarily unavailable.",
        502: "WHOISJSON service is temporarily unavailable.",
        503: "WHOISJSON service is temporarily unavailable.",
      };

      return {
        domain,
        ok: false,
        status: response.status,
        code: "LOOKUP_FAILED",
        error:
          errorMessages[response.status] ||
          `WHOISJSON lookup failed (${response.status}).`,
      };
    }

    const data: Record<string, any> = await response.json();

    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data)
    ) {
      throw new Error("Invalid WHOISJSON response.");
    }

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
    if (
      data.registered === false ||
      data.registered === "false"
    ) {
      return {
        domain,
        ok: false,
        status: 404,
        code: "NO_REGISTRATION_RECORD",
        error:
          "No registration record was returned. This does not prove domain availability.",
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

    // Convert WHOISJSON data into the RDAP structure
    // expected by the existing frontend parseRdap() function.
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
    console.error("WHOISJSON lookup error:", {
      domain,
      message:
        error instanceof Error
          ? error.message
          : "Unknown lookup error",
    });

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
          error: "Missing Supabase configuration or authentication.",
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
        { error: "Provide a non-empty domains array." },
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

      // Stop further provider requests when rate limited.
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

      // Small delay between provider requests.
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
