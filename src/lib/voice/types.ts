/**
 * One interface for placing calls, so the platform never names a telephony
 * vendor. Plivo implements it today; a LiveKit-backed provider will implement
 * the same thing when the conversation replaces the keypad.
 */

export type PlaceCallRequest = {
  to: string;
  from: string;
  /** Where the provider asks what to say; carries the case it is calling about. */
  answerUrl: string;
  /** Where call outcomes are reported. */
  statusUrl?: string;
  /** Seconds to ring before giving up. */
  ringTimeoutSeconds?: number;
  /** Hint for the provider, and recorded on the call. */
  caseId?: string;
};

export type PlaceCallResult = {
  providerCallId: string;
  /** True when nothing actually rang: dry run, or the fake provider. */
  simulated: boolean;
};

export type VoiceCapabilities = {
  reachesRealPeople: boolean;
  supportsKeypad: boolean;
  /** True once a provider can stream audio for a spoken conversation. */
  supportsSpeech: boolean;
};

export interface VoiceProvider {
  readonly name: string;
  readonly capabilities: VoiceCapabilities;
  placeCall(request: PlaceCallRequest): Promise<PlaceCallResult>;
}

export class VoiceError extends Error {
  constructor(
    message: string,
    readonly code?: string | number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'VoiceError';
  }
}

/** What the employee did at a prompt, however they expressed it. */
export type CallTurnInput = {
  /** Keypad press, when they used the keypad. */
  digits?: string;
  /** Transcribed speech, when they spoke instead. */
  speech?: string;
};
