// ======================================================
// LLM CLIENT FACTORY
// ======================================================
//
// Unified interface for multiple LLM providers (Gemini, Azure).
// Switch providers via LLM_PROVIDER environment variable.
// No SDK dependencies — plain fetch against REST APIs.

type LLMProvider = "gemini" | "azure";

export interface LLMClientOptions {
  provider?: LLMProvider;
  apiKey?: string;
  model?: string;
  temperature?: number;
}

export interface ILLMClient {
  generateJSON<T>(systemPrompt: string, userPrompt: string): Promise<T>;
}

/**
 * Factory function to create an LLM client based on provider.
 * Uses LLM_PROVIDER environment variable (defaults to "gemini").
 */
export function createLLMClient(options: LLMClientOptions = {}): ILLMClient {
  const provider = (options.provider ?? process.env.LLM_PROVIDER ?? "gemini") as LLMProvider;

  if (provider === "azure") {
    return new AzureLLMClient(options);
  } else if (provider === "gemini") {
    return new GeminiLLMClient(options);
  } else {
    throw new Error(`Unknown LLM provider: ${provider}. Use "gemini" or "azure".`);
  }
}

// ======================================================
// GEMINI CLIENT
// ======================================================

const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

class GeminiLLMClient implements ILLMClient {
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
    this.model = options.model ?? DEFAULT_GEMINI_MODEL;
    this.temperature = options.temperature ?? 0.1;
  }

  async generateJSON<T>(systemPrompt: string, userPrompt: string): Promise<T> {
    const url = `${GEMINI_API_BASE}/${this.model}:generateContent?key=${this.apiKey}`;

    console.log("[LLM-Client:Gemini] Sending request to Gemini API");
    console.log(`[LLM-Client:Gemini] Model: ${this.model}`);
    console.log(`[LLM-Client:Gemini] URL: ${url.replace(this.apiKey, "***REDACTED***")}`);
    console.log(`[LLM-Client:Gemini] Temperature: ${this.temperature}`);
    console.log(`[LLM-Client:Gemini] User prompt length: ${userPrompt.length} characters`);

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
      const errorName = fetchError instanceof Error ? fetchError.name : "Unknown";
      console.error("[LLM-Client:Gemini] ❌ Fetch failed (network error)");
      console.error(`[LLM-Client:Gemini] Error name: ${errorName}`);
      console.error(`[LLM-Client:Gemini] Error message: ${errorMsg}`);
      console.error(`[LLM-Client:Gemini] 📋 Diagnostic info:`);
      console.error(`[LLM-Client:Gemini]   - Check internet connection`);
      console.error(`[LLM-Client:Gemini]   - Verify firewall/proxy settings`);
      console.error(`[LLM-Client:Gemini]   - Ensure DNS can resolve generativelanguage.googleapis.com`);
      throw new Error(`Network error during Gemini API request: ${errorMsg}`);
    }

    console.log(`[LLM-Client:Gemini] Response status: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      const errorBody = await safeReadText(response);
      console.error(`[LLM-Client:Gemini] API request failed (${response.status})`);
      console.error(`[LLM-Client:Gemini] Error body: ${errorBody}`);

      if (response.status === 429) {
        console.error("[LLM-Client:Gemini] ⚠️ QUOTA EXCEEDED or RATE LIMITED");
      }

      if (response.status === 403) {
        console.error("[LLM-Client:Gemini] ⚠️ PERMISSION DENIED - Check API key and billing");
      }

      throw new Error(
        `Gemini API request failed (${response.status} ${response.statusText}): ${errorBody}`
      );
    }

    console.log("[LLM-Client:Gemini] Response received, parsing JSON...");
    let data: GeminiResponse;
    try {
      data = (await response.json()) as GeminiResponse;
    } catch (parseError) {
      const parseMsg = parseError instanceof Error ? parseError.message : String(parseError);
      console.error("[LLM-Client:Gemini] Failed to parse response as JSON");
      console.error(`[LLM-Client:Gemini] Parse error: ${parseMsg}`);
      throw parseError;
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      const finishReason = data.candidates?.[0]?.finishReason;
      console.warn(`[LLM-Client:Gemini] Response contained no text content`);
      console.warn(`[LLM-Client:Gemini] Finish reason: ${finishReason || "unknown"}`);
      throw new Error(
        `Gemini response contained no text content${
          finishReason ? ` (finishReason: ${finishReason})` : ""
        }`
      );
    }

    console.log(`[LLM-Client:Gemini] Text content received (${text.length} characters)`);

    try {
      const parsed = parseJsonResponse(text) as T;
      console.log("[LLM-Client:Gemini] JSON parsing successful ✓");
      return parsed;
    } catch (parseError) {
      const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
      console.error("[LLM-Client:Gemini] ❌ JSON parsing failed, attempting retry with feedback...");

      try {
        return await this.retryWithFeedback(text, errorMsg);
      } catch (retryError) {
        const retryMsg = retryError instanceof Error ? retryError.message : String(retryError);
        console.error("[LLM-Client:Gemini] ❌ Retry also failed");
        console.error(`[LLM-Client:Gemini] Retry error: ${retryMsg}`);
        throw retryError;
      }
    }
  }

  private async retryWithFeedback<T>(malformedText: string, parseErrorMsg: string): Promise<T> {
    const url = `${GEMINI_API_BASE}/${this.model}:generateContent?key=${this.apiKey}`;

    const correctionPrompt = `Your previous response had invalid JSON. Error: ${parseErrorMsg}

Return ONLY valid, strict JSON — no markdown code fences, no comments, no trailing commas.

WRONG:  "evidence": ["item1", "item2",]
RIGHT:  "evidence": ["item1", "item2"]

Every array and object must have no comma after its final element.

Malformed response was:
${malformedText.slice(0, 1000)}

Now return ONLY corrected valid JSON:`;

    console.log("[LLM-Client:Gemini] Sending retry request with error feedback...");

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

    console.log("[LLM-Client:Gemini] Retry response received, parsing corrected JSON...");

    try {
      const parsed = parseJsonResponse(text);
      console.log("[LLM-Client:Gemini] ✓ Retry parsing successful");
      return parsed as unknown as T;
    } catch (secondError) {
      const errorMsg = secondError instanceof Error ? secondError.message : String(secondError);
      throw new Error(`Retry parsing also failed: ${errorMsg}`);
    }
  }
}

interface GeminiResponse {
  candidates?: {
    content?: {
      parts?: { text?: string }[];
    };
    finishReason?: string;
  }[];
}

// ======================================================
// AZURE OPENAI CLIENT
// ======================================================

const DEFAULT_AZURE_MODEL = "gpt-5-mini";

class AzureLLMClient implements ILLMClient {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly deploymentName: string;
  private readonly temperature: number;

  constructor(options: LLMClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.AZURE_OPENAI_API_KEY;
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const deploymentName = options.model ?? process.env.AZURE_OPENAI_DEPLOYMENT ?? DEFAULT_AZURE_MODEL;

    if (!apiKey) {
      throw new Error(
        "Missing Azure OpenAI API key. Set AZURE_OPENAI_API_KEY or pass { apiKey } to LLMClient."
      );
    }

    if (!endpoint) {
      throw new Error(
        "Missing Azure OpenAI endpoint. Set AZURE_OPENAI_ENDPOINT environment variable."
      );
    }

    this.apiKey = apiKey;
    this.endpoint = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
    this.deploymentName = deploymentName;
    this.temperature = options.temperature ?? 0.1;
  }

  async generateJSON<T>(systemPrompt: string, userPrompt: string): Promise<T> {
    const url = `${this.endpoint}/openai/deployments/${this.deploymentName}/chat/completions?api-version=2024-08-01-preview`;

    console.log("[LLM-Client:Azure] Sending request to Azure OpenAI API");
    console.log(`[LLM-Client:Azure] Deployment: ${this.deploymentName}`);
    console.log(`[LLM-Client:Azure] Endpoint: ${this.endpoint}`);
    console.log(`[LLM-Client:Azure] User prompt length: ${userPrompt.length} characters`);

    let response: Response;
    try {
      // Build request body - Azure doesn't support temperature parameter for this model
      const requestBody: any = {
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: userPrompt,
          },
        ],
        response_format: { type: "json_object" },
      };

      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": this.apiKey,
        },
        body: JSON.stringify(requestBody),
      });
    } catch (fetchError) {
      const errorMsg = fetchError instanceof Error ? fetchError.message : String(fetchError);
      const errorName = fetchError instanceof Error ? fetchError.name : "Unknown";
      console.error("[LLM-Client:Azure] ❌ Fetch failed (network error)");
      console.error(`[LLM-Client:Azure] Error name: ${errorName}`);
      console.error(`[LLM-Client:Azure] Error message: ${errorMsg}`);
      console.error(`[LLM-Client:Azure] 📋 Diagnostic info:`);
      console.error(`[LLM-Client:Azure]   - Check internet connection`);
      console.error(`[LLM-Client:Azure]   - Verify firewall/proxy settings`);
      console.error(`[LLM-Client:Azure]   - Check Azure endpoint is accessible`);
      throw new Error(`Network error during Azure OpenAI API request: ${errorMsg}`);
    }

    console.log(`[LLM-Client:Azure] Response status: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      const errorBody = await safeReadText(response);
      console.error(`[LLM-Client:Azure] API request failed (${response.status})`);
      console.error(`[LLM-Client:Azure] Error body: ${errorBody}`);

      if (response.status === 429) {
        console.error("[LLM-Client:Azure] ⚠️ RATE LIMITED");
      }

      if (response.status === 401 || response.status === 403) {
        console.error("[LLM-Client:Azure] ⚠️ PERMISSION DENIED - Check API key and endpoint");
      }

      throw new Error(
        `Azure OpenAI API request failed (${response.status} ${response.statusText}): ${errorBody}`
      );
    }

    console.log("[LLM-Client:Azure] Response received, parsing JSON...");
    let data: AzureResponse;
    try {
      data = (await response.json()) as AzureResponse;
    } catch (parseError) {
      const parseMsg = parseError instanceof Error ? parseError.message : String(parseError);
      console.error("[LLM-Client:Azure] Failed to parse response as JSON");
      console.error(`[LLM-Client:Azure] Parse error: ${parseMsg}`);
      throw parseError;
    }

    const text = data.choices?.[0]?.message?.content;

    if (!text) {
      console.warn(`[LLM-Client:Azure] Response contained no text content`);
      throw new Error("Azure OpenAI response contained no text content");
    }

    console.log(`[LLM-Client:Azure] Text content received (${text.length} characters)`);

    try {
      const parsed = parseJsonResponse(text) as T;
      console.log("[LLM-Client:Azure] JSON parsing successful ✓");
      return parsed;
    } catch (parseError) {
      const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
      console.error("[LLM-Client:Azure] ❌ JSON parsing failed, attempting retry with feedback...");

      try {
        return await this.retryWithFeedback(text, errorMsg);
      } catch (retryError) {
        const retryMsg = retryError instanceof Error ? retryError.message : String(retryError);
        console.error("[LLM-Client:Azure] ❌ Retry also failed");
        console.error(`[LLM-Client:Azure] Retry error: ${retryMsg}`);
        throw retryError;
      }
    }
  }

  private async retryWithFeedback<T>(malformedText: string, parseErrorMsg: string): Promise<T> {
    const url = `${this.endpoint}/openai/deployments/${this.deploymentName}/chat/completions?api-version=2024-08-01-preview`;

    const correctionPrompt = `Your previous response had invalid JSON. Error: ${parseErrorMsg}

Return ONLY valid, strict JSON — no markdown code fences, no comments, no trailing commas.

WRONG:  "evidence": ["item1", "item2",]
RIGHT:  "evidence": ["item1", "item2"]

Every array and object must have no comma after its final element.

Malformed response was:
${malformedText.slice(0, 1000)}

Now return ONLY corrected valid JSON:`;

    console.log("[LLM-Client:Azure] Sending retry request with error feedback...");

    let response: Response;
    try {
      // Build request body - do NOT include temperature as Azure doesn't support it
      const requestBody: any = {
        messages: [
          {
            role: "system",
            content: "You are a JSON correction assistant. Return ONLY valid JSON.",
          },
          {
            role: "user",
            content: correctionPrompt,
          },
        ],
        response_format: { type: "json_object" },
      };

      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": this.apiKey,
        },
        body: JSON.stringify(requestBody),
      });
    } catch (fetchError) {
      const errorMsg = fetchError instanceof Error ? fetchError.message : String(fetchError);
      throw new Error(`Retry request failed (network error): ${errorMsg}`);
    }

    if (!response.ok) {
      const errorBody = await safeReadText(response);
      throw new Error(`Retry request failed (${response.status}): ${errorBody}`);
    }

    let data: AzureResponse;
    try {
      data = (await response.json()) as AzureResponse;
    } catch (parseError) {
      throw parseError;
    }

    const text = data.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error("Retry response contained no text content");
    }

    console.log("[LLM-Client:Azure] Retry response received, parsing corrected JSON...");

    try {
      const parsed = parseJsonResponse(text);
      console.log("[LLM-Client:Azure] ✓ Retry parsing successful");
      return parsed as unknown as T;
    } catch (secondError) {
      const errorMsg = secondError instanceof Error ? secondError.message : String(secondError);
      throw new Error(`Retry parsing also failed: ${errorMsg}`);
    }
  }
}

interface AzureResponse {
  choices?: {
    message?: {
      content?: string;
    };
  }[];
}

// ======================================================
// SHARED UTILITIES
// ======================================================

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
      console.error("[LLM-Client] First 1000 chars of cleaned text:\n", cleaned.slice(0, 1000));

      throw new Error(
        `Failed to parse response as JSON after cleanup: ${
          secondError instanceof Error ? secondError.message : String(secondError)
        }`
      );
    }
  }
}

/**
 * Default export for backward compatibility — creates a Gemini client.
 */
export class LLMClient extends GeminiLLMClient {}