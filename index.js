
/*
 * DARSH AI WORKER
 * Cloudflare Workers + Workers AI + Supabase Auth
 *
 * Required Cloudflare binding:
 * AI -> Workers AI
 *
 * Never put a Supabase service-role key in this file.
 */

const SUPABASE_URL = "https://avddejokgcrmkyqesgiq.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_osFU1IuYkmEvIoekiQuwRQ_oW2WPOwG";

const MODEL = "@cf/google/gemma-4-26b-a4b-it";
const FALLBACK_MODEL = "@cf/zai-org/glm-4.7-flash";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

async function readResponse(response) {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500) };
  }
}

function safeSupabaseError(data) {
  if (!data || typeof data !== "object") {
    return { message: "Supabase returned an unreadable error." };
  }

  const safe = {};

  for (const key of [
    "code",
    "error",
    "error_code",
    "msg",
    "message"
  ]) {
    if (typeof data[key] === "string") {
      safe[key] = data[key].slice(0, 300);
    }
  }

  return Object.keys(safe).length
    ? safe
    : { message: "Supabase rejected the request." };
}

async function consumeUse(token, dry) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/rpc/consume_use`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_ANON_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        tool: "ai",
        dry
      })
    }
  );

  const data = await readResponse(response);

  return {
    ok: response.ok,
    status: response.status,
    data
  };
}

function extractAnswer(result) {
  const content =
    result?.choices?.[0]?.message?.content ??
    result?.response ??
    result?.output_text ??
    result?.result?.response;

  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map(part =>
        typeof part === "string"
          ? part
          : typeof part?.text === "string"
            ? part.text
            : ""
      )
      .join("")
      .trim();
  }

  return "";
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS
      });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        status: "Darsh AI backend is online"
      });
    }

    if (request.method !== "POST" || url.pathname !== "/chat") {
      return json({ error: "Not found" }, 404);
    }

    const authorization =
      request.headers.get("Authorization") || "";

    const token = authorization.startsWith("Bearer ")
      ? authorization.slice(7).trim()
      : "";

    if (!token) {
      return json({
        error: "Login required. No access token was received."
      }, 401);
    }

    try {
      // 1. Validate the Supabase session.
      let userResponse;

      try {
        userResponse = await fetch(
          `${SUPABASE_URL}/auth/v1/user`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              apikey: SUPABASE_ANON_KEY
            }
          }
        );
      } catch (error) {
        console.error("Supabase auth network error", {
          message: String(error?.message || error).slice(0, 300)
        });

        return json({
          error: "Could not reach Supabase Auth."
        }, 502);
      }

      if (!userResponse.ok) {
        const errorData = await readResponse(userResponse);
        const details = safeSupabaseError(errorData);

        console.error("Supabase session validation failed", {
          status: userResponse.status,
          ...details
        });

        return json({
          error: "Supabase session validation failed",
          status: userResponse.status,
          details
        }, 401);
      }

      // 2. Read and validate the prompt.
      let body;

      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON body." }, 400);
      }

      const prompt =
        typeof body?.prompt === "string"
          ? body.prompt.trim()
          : "";

      if (!prompt) {
        return json({ error: "Prompt is required." }, 400);
      }

      if (prompt.length > 30000) {
        return json({ error: "Prompt is too long." }, 413);
      }

      // 3. Check usage limit before calling AI.
      let gate;

      try {
        gate = await consumeUse(token, true);
      } catch (error) {
        console.error("Usage pre-check network error", {
          message: String(error?.message || error).slice(0, 300)
        });

        return json({
          error: "Could not reach the usage service."
        }, 503);
      }

      if (!gate.ok) {
        console.error("Usage pre-check failed", {
          status: gate.status,
          details: safeSupabaseError(gate.data)
        });

        return json({
          error: "Could not check usage limit.",
          status: gate.status
        }, 503);
      }

      const gateData = Array.isArray(gate.data)
        ? gate.data[0]
        : gate.data;

      if (!(gateData?.ok ?? gateData?.allowed)) {
        return json({ error: "Usage limit reached." }, 402);
      }

      // 4. Try the primary model, then the fallback.
      const models = [MODEL, FALLBACK_MODEL];
      const modelErrors = [];
      let answer = "";
      let modelUsed = "";

      const messages = [
        {
          role: "system",
          content:
            "You are Darsh, a friendly multilingual AI assistant and PDF editing agent. Understand Hindi, Hinglish, English, and mixed-language requests. Reply in the user's language. For greetings, answer briefly. For PDF tasks, follow the supplied instructions. Preserve names, numbers, dates and replacement values exactly. Never claim an edit was completed unless the editor confirms it. If a request is ambiguous, ask a concise clarification. If JSON is requested, return valid JSON only, without markdown."
        },
        {
          role: "user",
          content: prompt
        }
      ];

      for (const model of models) {
        try {
          console.log("Workers AI attempt", {
            model,
            promptLength: prompt.length
          });

          const result = await env.AI.run(model, {
            messages,
            max_tokens: 2048,
            temperature: 0.1
          });

          const extracted = extractAnswer(result);

          if (extracted) {
            answer = extracted;
            modelUsed = model;
            break;
          }

          modelErrors.push({
            model,
            error: "Model returned no text."
          });

          console.error("Workers AI returned no text", {
            model,
            promptLength: prompt.length,
            resultKeys:
              result && typeof result === "object"
                ? Object.keys(result)
                : []
          });
        } catch (error) {
          const detail = String(
            error?.message || error || "Unknown AI error"
          ).slice(0, 500);

          modelErrors.push({
            model,
            error: detail
          });

          console.error("Workers AI invocation failed", {
            model,
            name: String(error?.name || "Error"),
            message: detail,
            promptLength: prompt.length
          });
        }
      }

      if (!answer) {
        return json({
          error: "All AI models failed.",
          details: modelErrors
        }, 502);
      }

      // 5. Record usage only after a successful AI response.
      let charged;

      try {
        charged = await consumeUse(token, false);
      } catch (error) {
        console.error("Usage recording network error", {
          message: String(error?.message || error).slice(0, 300)
        });

        return json({
          error: "AI answered, but usage could not be recorded."
        }, 503);
      }

      if (!charged.ok) {
        console.error("Usage recording failed", {
          status: charged.status,
          details: safeSupabaseError(charged.data)
        });

        return json({
          error: "AI answered, but usage could not be recorded."
        }, 503);
      }

      const chargedData = Array.isArray(charged.data)
        ? charged.data[0]
        : charged.data;

      if (!(chargedData?.ok ?? chargedData?.allowed)) {
        return json({ error: "Usage limit reached." }, 402);
      }

      return json({
        answer,
        model: modelUsed
      });
    } catch (error) {
      console.error("Darsh Worker request failed", {
        name: String(error?.name || "Error"),
        message: String(error?.message || error).slice(0, 500)
      });

      return json({
        error: "AI request failed.",
        details: String(error?.message || error).slice(0, 500)
      }, 502);
    }
  }
};
