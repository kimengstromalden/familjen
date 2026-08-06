import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.35.0";
import webpush from "https://esm.sh/web-push@3.5.0?bundle";

function getEnv(name: string) {
  const value = Deno.env.get(name);
  return value && value.trim() ? value.trim() : null;
}

function normalizeVapidEmail(email: string | null) {
  if (!email) return null;
  const trimmed = email.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("mailto:") || /^https?:\/\//.test(trimmed)) {
    return trimmed;
  }
  return `mailto:${trimmed}`;
}

function createSupabaseClient() {
  const supabaseUrl = getEnv("PROJECT_URL");
  const supabaseKey = getEnv("SERVICE_ROLE_KEY");
  if (!supabaseUrl) {
    throw new Error("Missing env: PROJECT_URL");
  }
  if (!supabaseKey) {
    throw new Error("Missing env: SERVICE_ROLE_KEY");
  }
  return createClient(supabaseUrl, supabaseKey);
}

function configureWebPush() {
  const vapidPublicKey = getEnv("VAPID_PUBLIC_KEY");
  const vapidPrivateKey = getEnv("VAPID_PRIVATE_KEY");
  const vapidEmail = normalizeVapidEmail(getEnv("VAPID_EMAIL") || "mailto:admin@example.com");
  if (!vapidPublicKey) {
    throw new Error("Missing env: VAPID_PUBLIC_KEY");
  }
  if (!vapidPrivateKey) {
    throw new Error("Missing env: VAPID_PRIVATE_KEY");
  }
  if (!vapidEmail) {
    throw new Error("Missing env: VAPID_EMAIL");
  }
  webpush.setVapidDetails(vapidEmail, vapidPublicKey, vapidPrivateKey);
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    },
  });
}

// Handle CORS preflight requests
function handleCORS(req: Request) {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    });
  }
  return null;
}

function parseSubscription(raw: unknown) {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("Invalid JSON in stored push subscription");
    }
  }
  return raw;
}

let supabaseClient: ReturnType<typeof createClient> | null = null;
let webPushConfigured = false;

function ensureSetup() {
  if (!webPushConfigured) {
    configureWebPush();
    webPushConfigured = true;
  }

  if (!supabaseClient) {
    supabaseClient = createSupabaseClient();
  }

  return supabaseClient;
}

export default {
  async fetch(req: Request) {
    // Handle CORS preflight
    const corsResponse = handleCORS(req);
    if (corsResponse) return corsResponse;

    if (req.method !== "POST") {
      return jsonResponse({ error: "Method Not Allowed" }, 405);
    }

    let supabase;
    try {
      supabase = ensureSetup();
    } catch (setupError) {
      console.error("Setup error:", setupError);
      return jsonResponse({ error: setupError?.message || "Function setup failed" }, 500);
    }

    let payload;
    try {
      payload = await req.json();
      console.log("Received payload:", payload);
      console.log("Payload member_name:", payload && payload.member_name);
    } catch (jsonError) {
      console.error("JSON parse error:", jsonError);
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    const { member_name, title, body } = payload as {
      member_name: string;
      title: string;
      body: string;
    };

    if (!member_name || !title || !body) {
      return jsonResponse({ error: "member_name, title and body are required" }, 400);
    }

    // Fetch ALL active subscriptions for this member (not just one)
    const { data, error } = await supabase
      .from("push_subscriptions")
      .select("subscription")
      .eq("member_name", member_name)
      .eq("active", true);

    if (error) {
      console.error("Supabase error:", error);
      return jsonResponse({ error: error.message }, 500);
    }

    if (!data || data.length === 0) {
      console.error("No active subscription found for:", member_name);
      return jsonResponse({ 
        error: "No active push subscription found for this member",
        hint: "Try clicking 'Aktivera notiser' in the app first"
      }, 404);
    }

    console.log(`Found ${data.length} active subscription(s) for ${member_name}`);

    // Send to ALL subscriptions (multiple devices/browsers)
    const sendResults = [];
    let anySuccess = false;

    for (const row of data) {
      let subscription;
      try {
        subscription = parseSubscription(row.subscription);
      } catch (parseError) {
        console.error("Subscription parse error:", parseError);
        sendResults.push({
          endpoint: "unknown",
          success: false,
          error: parseError?.message || "Invalid stored subscription",
        });
        continue;
      }

      try {
        const endpoint = subscription?.endpoint || "unknown";
        console.log("Sending push to endpoint:", endpoint);
        console.log("Payload:", { title, body });
        await webpush.sendNotification(subscription, JSON.stringify({ title, body }));
        console.log("Push successfully sent to endpoint:", endpoint);
        sendResults.push({ endpoint, success: true });
        anySuccess = true;
      } catch (sendError) {
        console.error("Push error:", sendError);
        console.error("Push error (stack):", sendError?.stack);
        
        // Auto-deactivate expired/invalid subscriptions
        if (sendError?.statusCode === 410 || sendError?.statusCode === 404 || sendError?.statusCode === 403) {
          console.log("Subscription expired or invalid, deactivating:", subscription?.endpoint);
          await supabase
            .from("push_subscriptions")
            .update({ active: false })
            .eq("member_name", member_name)
            .eq("subscription", row.subscription);
        }

        sendResults.push({
          endpoint: subscription?.endpoint || "unknown",
          success: false,
          error: sendError?.message || "Push send failed",
        });
      }
    }

    if (anySuccess) {
      return jsonResponse({ 
        ok: true, 
        sent: sendResults.filter(r => r.success).length,
        failed: sendResults.filter(r => !r.success).length,
        details: sendResults
      }, 200);
    }

    return jsonResponse({ 
      ok: false, 
      error: "All push sends failed",
      details: sendResults
    }, 500);
  },
};
