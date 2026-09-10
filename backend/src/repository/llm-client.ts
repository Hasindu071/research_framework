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
      const parsed = parseJsonResponse(text) as T;
      console.log("[LLM-Client] JSON parsing successful ✓");
      return parsed;
    } catch (parseError) {
      const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
      console.error("[LLM-Client] ❌ JSON parsing failed, attempting retry with feedback...");
      
      // Retry once with an error correction prompt
      try {
        return await this.retryWithFeedback(text, errorMsg);
      } catch (retryError) {
        const retryMsg = retryError instanceof Error ? retryError.message : String(retryError);
        console.error("[LLM-Client] ❌ Retry also failed");
        console.error(`[LLM-Client] Retry error: ${retryMsg}`);
        throw retryError;
      }
    }
  }

  /**
   * Retry JSON generation with explicit feedback about what went wrong.
   * Sends the malformed response and the error back to the model and asks
   * for corrected valid JSON.
   */
  private async retryWithFeedback<T>(malformedText: string, parseErrorMsg: string): Promise<T> {
    const url = `${process.env.GEMINI_API_KEY ? `${API_BASE}/${this.model}:generateContent?key=${this.apiKey}` : ''}`;
    
    const correctionPrompt = `Your previous response had invalid JSON. Error: ${parseErrorMsg}

Return ONLY valid, strict JSON — no markdown code fences, no comments, no trailing commas.

WRONG:  "evidence": ["item1", "item2",]
RIGHT:  "evidence": ["item1", "item2"]

Every array and object must have no comma after its final element.

Malformed response was:
${malformedText.slice(0, 1000)}

Now return ONLY corrected valid JSON:`;

    console.log("[LLM-Client] Sending retry request with error feedback...");

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: "You are a JSON correction assistant. Return ONLY valid JSON." }],
          },
          contents: [
            {
              role: "user",
              parts: [{ text: correctionPrompt }],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.1,
          },
        }),
      });
    } catch (fetchError) {
      const errorMsg = fetchError instanceof Error ? fetchError.message : String(fetchError);
      throw new Error(`Retry request failed (network error): ${errorMsg}`);
    }

    if (!response.ok) {
      const errorBody = await safeReadText(response);
      throw new Error(`Retry request failed (${response.status}): ${errorBody}`);
    }

    let data: GeminiResponse;
    try {
      data = (await response.json()) as GeminiResponse;
    } catch (parseError) {
      throw parseError;
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error("Retry response contained no text content");
    }

    console.log("[LLM-Client] Retry response received, parsing corrected JSON...");

    try {
      const parsed = parseJsonResponse(text);
      console.log("[LLM-Client] ✓ Retry parsing successful");
      return parsed as unknown as T;
    } catch (secondError) {
      const errorMsg = secondError instanceof Error ? secondError.message : String(secondError);
      throw new Error(`Retry parsing also failed: ${errorMsg}`);
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

/**
 * Parse JSON with cleanup of common malformations from LLM responses.
 * Handles:
 * - Markdown code fences (```json ... ```)
 * - Trailing commas before closing brackets/braces
 * - Multi-pass cleanup for cascading comma issues
 * 
 * Throws with detailed diagnostics if cleanup doesn't fix the JSON.
 */
function parseJsonResponse(text: string): any {
  let cleaned = text.trim();

  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  // Remove trailing commas before } or ], allowing whitespace/newlines between
  cleaned = cleaned.replace(/,(\s*[}\]])/g, "$1");

  try {
    return JSON.parse(cleaned);
  } catch (firstError) {
    // Second pass: sometimes a trailing comma removal cascades and exposes
    // another trailing comma that the first regex's lookahead already consumed past.
    // Rare, but cheap to guard against.
    const secondPass = cleaned.replace(/,(\s*[}\]])/g, "$1");
    try {
      return JSON.parse(secondPass);
    } catch (secondError) {
      console.error("[LLM-Client] JSON parse failed after cleanup attempts");
      console.error(
        "[LLM-Client] Original length:",
        text.length,
        "| Cleaned length:",
        cleaned.length
      );
      console.error(
        "[LLM-Client] First 1000 chars of cleaned text:\n",
        cleaned.slice(0, 1000)
      );

      throw new Error(
        `Failed to parse Gemini response as JSON after cleanup: ${
          secondError instanceof Error ? secondError.message : String(secondError)
        }`
      );
    }
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