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

    const response = await fetch(url, {
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

    if (!response.ok) {
      const errorBody = await safeReadText(response);
      throw new Error(
        `Gemini API request failed (${response.status} ${response.statusText}): ${errorBody}`
      );
    }

    const data = (await response.json()) as GeminiResponse;

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      const finishReason = data.candidates?.[0]?.finishReason;
      throw new Error(
        `Gemini response contained no text content${
          finishReason ? ` (finishReason: ${finishReason})` : ""
        }`
      );
    }

    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new Error(
        `Failed to parse Gemini response as JSON: ${
          (error as Error).message
        }\n---\nRaw response:\n${text}`
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