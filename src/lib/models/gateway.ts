import { AnthropicProvider, OpenAIProvider, SarvamProvider, StubProvider } from './providers';
import { isIndic, ModelError, type ModelProvider, type ModelRequest, type ModelResult, type ModelTask } from './types';

/**
 * Chooses a model per task and language, and falls back when one is unwell.
 *
 * Preference order, before a tenant override:
 *   Indian-language text  -> Sarvam, then OpenAI, then Anthropic
 *   everything else       -> OpenAI, then Anthropic, then Sarvam
 *
 * If every provider fails, the caller gets an error rather than a guess, and the
 * conversation hands the case to a human.
 */
export class ModelGateway {
  private readonly providers: Record<string, ModelProvider>;

  constructor(providers?: ModelProvider[]) {
    const list = providers ?? [new OpenAIProvider(), new AnthropicProvider(), new SarvamProvider(), new StubProvider()];
    this.providers = Object.fromEntries(list.map((p) => [p.name, p]));
  }

  /** What is actually usable right now, for the portal's capability panel. */
  status(): { provider: string; available: boolean }[] {
    return Object.values(this.providers).map((p) => ({ provider: p.name, available: p.available() }));
  }

  private order(task: ModelTask, language: string | undefined, override?: string): ModelProvider[] {
    const names = isIndic(language)
      ? ['sarvam', 'openai', 'anthropic']
      : ['openai', 'anthropic', 'sarvam'];

    if (override && this.providers[override]) {
      names.splice(names.indexOf(override), 1);
      names.unshift(override);
    }

    const chosen = names
      .map((n) => this.providers[n])
      .filter((p): p is ModelProvider => Boolean(p?.available() && p.handlesLanguage(language)));

    // The stub is last, and only so that local development without any key
    // still exercises the full flow (it always answers "unclear").
    const stub = this.providers.stub;
    if (stub) chosen.push(stub);
    return chosen;
  }

  async json<T>(request: ModelRequest, opts: { tenantOverride?: string } = {}): Promise<ModelResult<T>> {
    const candidates = this.order(request.task, request.language, opts.tenantOverride);
    const attempts: { provider: string; error: string }[] = [];

    for (const provider of candidates) {
      const startedAt = Date.now();
      try {
        const result = await provider.json<T>(request);
        return {
          ...result,
          provider: provider.name,
          latencyMs: Date.now() - startedAt,
          fallbackUsed: attempts.length > 0,
          attempts,
        };
      } catch (error) {
        attempts.push({ provider: provider.name, error: (error as Error).message });
        // A missing key is not a failure worth reporting; a real error is.
        if (!(error instanceof ModelError) || error.retryable) {
          console.warn(`[models] ${provider.name} failed for ${request.task}: ${(error as Error).message}`);
        }
      }
    }

    throw new ModelError(
      `No model could answer ${request.task}: ${attempts.map((a) => `${a.provider} (${a.error})`).join('; ')}`,
      'gateway',
      false,
    );
  }
}

/** Shared instance; tests construct their own with fakes. */
export const models = new ModelGateway();
