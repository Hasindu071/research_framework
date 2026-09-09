// ======================================================
// GEMINI CLIENT
// ======================================================
//
// Deliberately thin: one method (`generateJSON`) that sends a
// system + user prompt and requires the model to return structured
// JSON, using Gemini's `responseMimeType: "application/json"` so we
// aren't parsing prose out of a chat response.
//
// No SDK dependency — plain fetch against the REST API — so this
// has no install footprint beyond a native fetch runtime (Node 18+).

const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export interface LLMClientOptions {
  /** Defaults to process.env.GEMINI_API_KEY. */
  apiKey?: string;
  model?: string;
  /** Passed through to Gemini's generationConfig.temperature. */
  temperature?: number;
}

export class LLMClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly temperature: number;

  constructor(options: LLMClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;

    if (!apiKey) {
      throw new Error(
        "Missing Gemini API key. Set GEMINI_API_KEY or pass { apiKey } to LLMClient."
      );
    }

    this.apiKey = apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.temperature = options.temperature ?? 0.1;
  }

  /**
   * Send a system + user prompt and parse the model's response as
   * JSON of type T.
   *
   * Throws on HTTP failure, an empty response, or a response that
   * doesn't parse as JSON — callers should treat all of these as
   * "the LLM step failed", not silently fall back to guessing.
   */
  async generateJSON<T>(systemPrompt: string, userPrompt: string): Promise<T> {
    const url = `${API_BASE}/${this.model}:generateContent?key=${this.apiKey}`;

    console.log("[LLM-Client] Sending request to Gemini API");
    console.log(`[LLM-Client] Model: ${this.model}`);
    console.log(`[LLM-Client] URL: ${url.replace(this.apiKey, "***REDACTED***")}`);
    console.log(`[LLM-Client] Temperature: ${this.temperature}`);
    console.log(`[LLM-Client] User prompt length: ${userPrompt.length} characters`);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemPrompt }],
          },
          contents: [
            {
              role: "user",
              parts: [{ text: userPrompt }],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: this.temperature,
          },
        }),
      });
    } catch (fetchError) {
      const errorMsg = fetchError instanceof Error ? fetchError.message : String(fetchError);
      const errorName = fetchError instanceof Error ? fetchError.name : 'Unknown';
      console.error("[LLM-Client] ❌ Fetch failed (network error)");
      console.error(`[LLM-Client] Error name: ${errorName}`);
      console.error(`[LLM-Client] Error message: ${errorMsg}`);
      console.error(`[LLM-Client] 📋 Diagnostic info:`);
      console.error(`[LLM-Client]   - Check internet connection`);
      console.error(`[LLM-Client]   - Verify firewall/proxy settings`);
      console.error(`[LLM-Client]   - Ensure DNS can resolve generativelanguage.googleapis.com`);
      console.error(`[LLM-Client]   - Check if Gemini API is accessible: curl https://generativelanguage.googleapis.com`);
      throw new Error(`Network error during Gemini API request: ${errorMsg}`);
    }

    console.log(`[LLM-Client] Response status: ${response.status} ${response.statusText}`);

    // Log quota-related headers
    const quotaLimit = response.headers.get("x-goog-quota-project-id");
    const quotaUser = response.headers.get("x-goog-user-project");
    const rateLimit = response.headers.get("x-ratelimit-limit-requests-per-minute");
    const rateLimitRemaining = response.headers.get("x-ratelimit-remaining-requests-per-minute");
    const rateLimitReset = response.headers.get("x-ratelimit-reset-requests-per-minute");

    if (quotaLimit) console.log(`[LLM-Client] Quota project: ${quotaLimit}`);
    if (quotaUser) console.log(`[LLM-Client] User project: ${quotaUser}`);
    if (rateLimit) console.log(`[LLM-Client] Rate limit (requests/min): ${rateLimit}`);
    if (rateLimitRemaining) console.log(`[LLM-Client] Remaining requests/min: ${rateLimitRemaining}`);
    if (rateLimitReset) console.log(`[LLM-Client] Rate limit reset in: ${rateLimitReset}s`);

    if (!response.ok) {
      const errorBody = await safeReadText(response);
      console.error(`[LLM-Client] API request failed (${response.status})`);
      console.error(`[LLM-Client] Error body: ${errorBody}`);

      // Check for quota exceeded error
      if (response.status === 429) {
        console.error("[LLM-Client] ⚠️ QUOTA EXCEEDED or RATE LIMITED");
        console.error(`[LLM-Client] Remaining: ${rateLimitRemaining || 'unknown'}`);
        console.error(`[LLM-Client] Reset in: ${rateLimitReset || 'unknown'} seconds`);
      }

      if (response.status === 403) {
        console.error("[LLM-Client] ⚠️ PERMISSION DENIED - Check API key and billing");
      }

      throw new Error(
        `Gemini API request failed (${response.status} ${response.statusText}): ${errorBody}`
      );
    }

    console.log("[LLM-Client] Response received, parsing JSON...");
    let data: GeminiResponse;
    try {
      data = (await response.json()) as GeminiResponse;
    } catch (parseError) {
      const parseMsg = parseError instanceof Error ? parseError.message : String(parseError);
      console.error("[LLM-Client] Failed to parse response as JSON");
      console.error(`[LLM-Client] Parse error: ${parseMsg}`);
      throw parseError;
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      const finishReason = data.candidates?.[0]?.finishReason;
      console.warn(`[LLM-Client] Response contained no text content`);
      console.warn(`[LLM-Client] Finish reason: ${finishReason || 'unknown'}`);
      throw new Error(
        `Gemini response contained no text content${
          finishReason ? ` (finishReason: ${finishReason})` : ""
        }`
      );
    }

    console.log(`[LLM-Client] Text content received (${text.length} characters)`);

    try {
      const parsed = JSON.parse(text) as T;
      console.log("[LLM-Client] JSON parsing successful ✓");
      return parsed;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error("[LLM-Client] Failed to parse Gemini response as JSON");
      console.error(`[LLM-Client] JSON parse error: ${errorMsg}`);
      console.error(`[LLM-Client] Raw response preview: ${text.substring(0, 200)}...`);
      throw new Error(
        `Failed to parse Gemini response as JSON: ${errorMsg}\n---\nRaw response:\n${text}`
      );
    }
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<unreadable response body>";
  }
}

// ======================================================
// MINIMAL RESPONSE SHAPE
// ======================================================
//
// We only type the fields we actually read. The real API response
// has more (safety ratings, usage metadata, etc.) that callers can
// add here if a future consumer needs them.

interface GeminiResponse {
  candidates?: {
    content?: {
      parts?: { text?: string }[];
    };
    finishReason?: string;
  }[];
}