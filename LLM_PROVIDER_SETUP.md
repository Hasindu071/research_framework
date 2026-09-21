# LLM Provider Setup & Switching Guide

## Overview

You now have a flexible LLM client that supports multiple providers (Gemini and Azure OpenAI). Switch between them easily using the `LLM_PROVIDER` environment variable.

## Supported Providers

- **gemini** (default): Google's Gemini API
- **azure**: Azure OpenAI API

## Environment Variables

### LLM Provider Selection
```env
# Set which provider to use (defaults to "gemini")
LLM_PROVIDER=gemini
# or
LLM_PROVIDER=azure
```

### Gemini Configuration
```env
GEMINI_API_KEY=your-gemini-api-key-here
```

### Azure OpenAI Configuration
```env
AZURE_OPENAI_API_KEY=your-azure-api-key-here
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/
AZURE_OPENAI_DEPLOYMENT=gpt-5-mini
```

## How to Switch Providers

### Option 1: Update `.env` file
```bash
# For Gemini (default)
LLM_PROVIDER=gemini

# For Azure
LLM_PROVIDER=azure
```

### Option 2: Set environment variable at runtime
```bash
# Linux/Mac
export LLM_PROVIDER=azure

# Windows (CMD)
set LLM_PROVIDER=azure

# Windows (PowerShell)
$env:LLM_PROVIDER = "azure"
```

### Option 3: Pass to Node.js
```bash
LLM_PROVIDER=azure npm start
```

## Configuration Details

### Gemini Setup
1. Create API key at [Google AI Studio](https://aistudio.google.com/)
2. Set `GEMINI_API_KEY` in `.env`
3. Set `LLM_PROVIDER=gemini` (or leave as default)
4. Optional: Set custom model via `--model` flag when creating client

### Azure OpenAI Setup
1. Create Azure OpenAI resource in Azure Portal
2. Get API key from "Keys and Endpoint" section
3. Get deployment name (e.g., "gpt-5-mini")
4. Set environment variables:
   - `AZURE_OPENAI_API_KEY`
   - `AZURE_OPENAI_ENDPOINT`
   - `AZURE_OPENAI_DEPLOYMENT`
5. Set `LLM_PROVIDER=azure`

## Code Usage

### Using Factory Function (Recommended)
```typescript
import { createLLMClient } from "./repository/llm-client.js";

// Create client based on LLM_PROVIDER env variable
const llmClient = createLLMClient();

// Or specify provider explicitly
const geminiClient = createLLMClient({ provider: "gemini" });
const azureClient = createLLMClient({ provider: "azure" });

// Use the client
const result = await llmClient.generateJSON(systemPrompt, userPrompt);
```

### Legacy Direct Import (Still Supported)
```typescript
import { LLMClient } from "./repository/llm-client.js";

// Creates Gemini client for backward compatibility
const client = new LLMClient();
const result = await client.generateJSON(systemPrompt, userPrompt);
```

## Comparing Providers for Accuracy

Both providers support the same interface, making it easy to test accuracy:

```typescript
import { createLLMClient } from "./repository/llm-client.js";

// Test with Gemini
process.env.LLM_PROVIDER = "gemini";
const geminiResult = await createLLMClient().generateJSON(system, user);

// Test with Azure
process.env.LLM_PROVIDER = "azure";
const azureResult = await createLLMClient().generateJSON(system, user);

// Compare results
console.log("Gemini:", geminiResult);
console.log("Azure:", azureResult);
```

## Logging

Both providers log detailed information including:
- Provider name (Gemini or Azure)
- Model/Deployment being used
- Temperature setting
- Request size and response status
- Rate limiting and quota information
- Retry attempts if parsing fails

Output includes provider prefixes:
- `[LLM-Client:Gemini]` for Gemini requests
- `[LLM-Client:Azure]` for Azure requests

## Error Handling

Both providers handle:
- Network errors with clear diagnostic messages
- Invalid JSON responses with automatic retry with feedback
- Rate limiting (429) and permission errors (403/401)
- Detailed error messages for debugging

## Current Configuration (.env)

Your current `.env` has:
- `LLM_PROVIDER=gemini` (default, change to `azure` to switch)
- Gemini API key configured
- Azure endpoints configured (fill in AZURE_OPENAI_API_KEY to use)

## Next Steps

1. **To use Gemini (current)**: Ensure `LLM_PROVIDER=gemini` and `GEMINI_API_KEY` is set
2. **To use Azure**: 
   - Set `AZURE_OPENAI_API_KEY` in `.env`
   - Change `LLM_PROVIDER=azure`
3. **To test both**: Create a comparison script that runs the same prompts with both providers

## Support for Additional Providers

To add more providers (e.g., OpenAI, Claude, LLaMA):

1. Create a new class in `llm-client.ts` implementing `ILLMClient`
2. Add provider type to the `LLMProvider` union
3. Update the factory function's switch statement
4. Add environment variables for configuration

Example:
```typescript
type LLMProvider = "gemini" | "azure" | "openai" | "claude";

class OpenAILLMClient implements ILLMClient {
  // Implementation
}

// In factory:
case "openai":
  return new OpenAILLMClient(options);
```
