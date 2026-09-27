import { randomUUID } from 'node:crypto';
import type { PlaceCallRequest, PlaceCallResult, VoiceCapabilities, VoiceProvider } from './types';

/**
 * A phone line that rings nobody. The call flow is built and tested against
 * this, so the only thing a real call adds is the audio.
 */
export class FakeVoiceProvider implements VoiceProvider {
  readonly name = 'fake';
  readonly capabilities: VoiceCapabilities = {
    reachesRealPeople: false,
    supportsKeypad: true,
    supportsSpeech: false,
  };

  private readonly placed: { at: Date; request: PlaceCallRequest; providerCallId: string }[] = [];

  async placeCall(request: PlaceCallRequest): Promise<PlaceCallResult> {
    if (!/^\+?\d{8,15}$/.test(request.to)) throw new Error(`"${request.to}" is not a callable number`);
    const providerCallId = `fakecall.${randomUUID()}`;
    this.placed.push({ at: new Date(), request, providerCallId });
    return { providerCallId, simulated: true };
  }

  history(to?: string) {
    return to ? this.placed.filter((c) => c.request.to === to) : [...this.placed];
  }

  clear() {
    this.placed.length = 0;
  }
}
