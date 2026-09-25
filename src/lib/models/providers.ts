import OpenAI from 'openai';
import { env } from '@/lib/env';
import { isIndic, ModelError, type ModelProvider, type ModelRequest, type ProviderResult } from './types';

const TIMEOUT_MS = 20_000;

/** GPT-4o mini: the default for English and Hinglish classification and dialogue. */
export class OpenAIProvider implements ModelProvider {
  readonly name = 'openai';
  private client: OpenAI | null = null;

  available(): boolean {
    return Boolean(env.OPENAI_API_KEY);
  }

  /** Capable in Indian languages, but Sarvam is preferred; the gateway orders them. */
  handlesLanguage(): boolean {
    return true;
  }

  async json<T>(request: ModelRequest): Promise<ProviderResult<T>> {
    if (!this.available()) throw new ModelError('OPENAI_API_KEY is not set', this.name, false);
    this.client ??= new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: TIMEOUT_MS, maxRetries: 1 });

    try {
      const response = await this.client.chat.completions.create({
        model: env.OPENAI_MODEL,
        temperature: request.temperature ?? 0,
        max_tokens: request.maxTokens ?? 500,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: request.schemaName, strict: true, schema: request.schema },
        },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) throw new ModelError('OpenAI returned no content', this.name);
      return {
        data: JSON.parse(content) as T,
        model: response.model,
        usage: {
          inputTokens: response.usage?.prompt_tokens,
          outputTokens: response.usage?.completion_tokens,
        },
      };
    } catch (cause) {
      if (cause instanceof ModelError) throw cause;
      throw new ModelError(`OpenAI failed: ${(cause as Error).message}`, this.name);
    }
  }
}

/**
 * Claude Haiku, called over HTTP so the platform carries no extra SDK.
 * Structured output uses a single tool whose input schema is the shape we want,
 * which is Anthropic's reliable way to get strict JSON.
 */
export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';

  available(): boolean {
    return Boolean(env.ANTHROPIC_API_KEY);
  }

  handlesLanguage(): boolean {
    return true;
  }

  async json<T>(request: ModelRequest): Promise<ProviderResult<T>> {
    if (!this.available()) throw new ModelError('ANTHROPIC_API_KEY is not set', this.name, false);

    const body = {
      model: env.ANTHROPIC_MODEL,
      max_tokens: request.maxTokens ?? 500,
      temperature: request.temperature ?? 0,
      system: request.system,
      messages: [{ role: 'user', content: request.user }],
      tools: [
        {
          name: request.schemaName,
          description: 'Return the result in this exact shape.',
          input_schema: request.schema,
        },
      ],
      tool_choice: { type: 'tool', name: request.schemaName },
    };

    let response: Response;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': env.ANTHROPIC_API_KEY!,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (cause) {
      throw new ModelError(`Anthropic unreachable: ${(cause as Error).message}`, this.name);
    }

    const json = (await response.json().catch(() => ({}))) as {
      content?: { type: string; input?: unknown }[];
      model?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
      error?: { message?: string };
    };
    if (!response.ok) {
      throw new ModelError(json.error?.message ?? `Anthropic returned HTTP ${response.status}`, this.name);
    }

    const toolUse = json.content?.find((c) => c.type === 'tool_use');
    if (!toolUse?.input) throw new ModelError('Anthropic returned no structured output', this.name);
    return {
      data: toolUse.input as T,
      model: json.model ?? env.ANTHROPIC_MODEL,
      usage: { inputTokens: json.usage?.input_tokens, outputTokens: json.usage?.output_tokens },
    };
  }
}

/**
 * Sarvam AI: preferred for Indian languages and code-mixed text, and the source
 * of the speech models used on calls.
 *
 * The chat endpoint is OpenAI-compatible. Sarvam has no strict-schema mode, so
 * the schema is placed in the prompt and the reply is parsed defensively —
 * exactly the behaviour to verify against a live key before enabling a tenant.
 */
export class SarvamProvider implements ModelProvider {
  readonly name = 'sarvam';

  available(): boolean {
    return Boolean(env.SARVAM_API_KEY);
  }

  handlesLanguage(language: string | undefined): boolean {
    return isIndic(language) || language === undefined || language.startsWith('en');
  }

  async json<T>(request: ModelRequest): Promise<ProviderResult<T>> {
    if (!this.available()) throw new ModelError('SARVAM_API_KEY is not set', this.name, false);

    const system = `${request.system}\n\nReply with JSON only, matching this schema exactly:\n${JSON.stringify(
      request.schema,
    )}`;

    let response: Response;
    try {
      response = await fetch('https://api.sarvam.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'api-subscription-key': env.SARVAM_API_KEY!,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: env.SARVAM_CHAT_MODEL,
          temperature: request.temperature ?? 0,
          max_tokens: request.maxTokens ?? 500,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: request.user },
          ],
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (cause) {
      throw new ModelError(`Sarvam unreachable: ${(cause as Error).message}`, this.name);
    }

    const json = (await response.json().catch(() => ({}))) as {
      choices?: { message?: { content?: string } }[];
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string } | string;
    };
    if (!response.ok) {
      const message = typeof json.error === 'string' ? json.error : json.error?.message;
      throw new ModelError(message ?? `Sarvam returned HTTP ${response.status}`, this.name);
    }

    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new ModelError('Sarvam returned no content', this.name);
    return {
      data: parseLooseJson<T>(content, this.name),
      model: json.model ?? env.SARVAM_CHAT_MODEL,
      usage: { inputTokens: json.usage?.prompt_tokens, outputTokens: json.usage?.completion_tokens },
    };
  }
}

/**
 * Stands in for a model when no key is configured at all.
 *
 * It answers only what can be answered without intelligence: nothing. Every
 * response is "unclear", which routes the case to a human. That keeps local
 * development honest — the platform degrades to handing over, never to guessing.
 */
export class StubProvider implements ModelProvider {
  readonly name = 'stub';

  available(): boolean {
    return true;
  }

  handlesLanguage(): boolean {
    return true;
  }

  async json<T>(request: ModelRequest): Promise<ProviderResult<T>> {
    const properties = (request.schema.properties ?? {}) as Record<string, { type?: string; enum?: unknown[] }>;
    const data: Record<string, unknown> = {};
    for (const [key, spec] of Object.entries(properties)) {
      if (key === 'intent') data[key] = 'unclear';
      else if (key === 'confidence') data[key] = 0;
      else if (spec.enum?.length) data[key] = spec.enum.includes('unclear') ? 'unclear' : spec.enum[0];
      else if (spec.type === 'number' || spec.type === 'integer') data[key] = 0;
      else if (spec.type === 'boolean') data[key] = false;
      else if (spec.type === 'array') data[key] = [];
      else if (spec.type === 'object') data[key] = {};
      else data[key] = null;
    }
    return { data: data as T, model: 'stub' };
  }
}

/** Models sometimes wrap JSON in prose or a code fence; recover what we can. */
export function parseLooseJson<T>(content: string, provider: string): T {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(content);
  const candidate = (fenced?.[1] ?? content).trim();
  try {
    return JSON.parse(candidate) as T;
  } catch {
    const braces = /\{[\s\S]*\}/.exec(candidate);
    if (braces) {
      try {
        return JSON.parse(braces[0]) as T;
      } catch {
        /* fall through */
      }
    }
    throw new ModelError('Could not parse the model response as JSON', provider);
  }
}
