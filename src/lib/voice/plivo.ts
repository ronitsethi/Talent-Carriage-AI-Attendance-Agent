import { VoiceError, type PlaceCallRequest, type PlaceCallResult, type VoiceCapabilities, type VoiceProvider } from './types';

export type PlivoConfig = {
  authId: string;
  authToken: string;
  /** Built and validated, but never sent. */
  dryRun?: boolean;
};

/**
 * Plivo voice. The call is placed here; what the caller hears comes from our
 * own answer URL, which Plivo fetches the moment the call connects.
 */
export class PlivoVoiceProvider implements VoiceProvider {
  readonly name = 'plivo';
  readonly capabilities: VoiceCapabilities = {
    reachesRealPeople: true,
    supportsKeypad: true,
    // Plivo can stream audio, but the spoken conversation is not built yet.
    supportsSpeech: false,
  };

  constructor(private readonly config: PlivoConfig) {}

  async placeCall(request: PlaceCallRequest): Promise<PlaceCallResult> {
    const body = buildPlivoCallPayload(request);
    if (this.config.dryRun) {
      return { providerCallId: `dry.${Date.now()}`, simulated: true };
    }

    let response: Response;
    try {
      response = await fetch(`https://api.plivo.com/v1/Account/${this.config.authId}/Call/`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.config.authId}:${this.config.authToken}`).toString('base64')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (cause) {
      throw new VoiceError(`Plivo unreachable: ${(cause as Error).message}`, 'network', true);
    }

    const json = (await response.json().catch(() => ({}))) as { request_uuid?: string; error?: string; message?: string };
    if (!response.ok) {
      throw new VoiceError(
        json.error ?? json.message ?? `Plivo returned HTTP ${response.status}`,
        response.status,
        response.status >= 500 || response.status === 429,
      );
    }
    if (!json.request_uuid) throw new VoiceError('Plivo accepted the call but returned no id', 'no_id');
    return { providerCallId: json.request_uuid, simulated: false };
  }
}

/** Pure, so the request shape can be asserted without calling anyone. */
export function buildPlivoCallPayload(request: PlaceCallRequest): Record<string, unknown> {
  return {
    to: request.to.replace(/^\+/, ''),
    from: request.from.replace(/^\+/, ''),
    answer_url: request.answerUrl,
    answer_method: 'POST',
    ...(request.statusUrl ? { hangup_url: request.statusUrl, hangup_method: 'POST' } : {}),
    ring_timeout: request.ringTimeoutSeconds ?? 30,
  };
}
