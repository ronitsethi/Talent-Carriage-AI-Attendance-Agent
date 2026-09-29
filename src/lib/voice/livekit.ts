import crypto from 'node:crypto';
import { VoiceError, type PlaceCallRequest, type PlaceCallResult, type VoiceProvider } from './types';

/**
 * Calls carried by LiveKit, for the spoken conversation.
 *
 * LiveKit does not own a phone line; it hands the call to Plivo over a SIP
 * trunk. So the number the employee sees is the same one the keypad calls come
 * from - only what happens after they answer is different.
 *
 * Placing a call means creating a room and dialling the employee into it. The
 * agent worker is waiting for that room, joins it, and talks. The call id
 * travels in the room name, which is how the worker knows who it is ringing.
 */
export type LiveKitConfig = {
  url: string;
  apiKey: string;
  apiSecret: string;
  /** The outbound trunk that reaches the phone network. */
  sipTrunkId: string;
  dryRun?: boolean;
};

export const ROOM_PREFIX = 'attendance-call-';

/** The call this room is about. Rooms are named, not numbered, for exactly this. */
export function callIdFromRoom(room: string): string | null {
  return room.startsWith(ROOM_PREFIX) ? room.slice(ROOM_PREFIX.length) : null;
}

export class LiveKitVoiceProvider implements VoiceProvider {
  readonly name = 'livekit';
  readonly capabilities = { reachesRealPeople: true, supportsKeypad: true, supportsSpeech: true };

  constructor(private readonly config: LiveKitConfig) {}

  async placeCall(request: PlaceCallRequest): Promise<PlaceCallResult> {
    if (this.config.dryRun) return { providerCallId: `dry.${Date.now()}`, simulated: true };
    if (!request.caseId) throw new VoiceError('A LiveKit call needs the case it is about', 'bad_request');

    const room = `${ROOM_PREFIX}${this.callId(request)}`;
    const body = {
      sip_trunk_id: this.config.sipTrunkId,
      sip_call_to: request.to,
      room_name: room,
      participant_identity: 'employee',
      participant_name: 'Employee',
      // Returning as soon as it is ringing keeps the portal responsive; the
      // outcome arrives the same way a keypad call's does, through the
      // conversation itself and the hangup webhook.
      wait_until_answered: false,
      ringing_timeout: `${request.ringTimeoutSeconds ?? 45}s`,
    };

    const response = await this.rpc('SIP', 'CreateSIPParticipant', body);
    const json = (await response.json().catch(() => ({}))) as { sip_call_id?: string; msg?: string };

    if (!response.ok) {
      throw new VoiceError(json.msg ?? `LiveKit refused the call (${response.status})`, response.status, response.status >= 500);
    }
    return { providerCallId: json.sip_call_id ?? room, simulated: false };
  }

  /**
   * The answer URL carries the call id for Plivo; here it names the room. Both
   * end up asking our own turn API the same question.
   */
  private callId(request: PlaceCallRequest): string {
    const fromUrl = /[?&]call=([0-9a-f-]{36})/i.exec(request.answerUrl)?.[1];
    if (!fromUrl) throw new VoiceError('Could not tell which call this is', 'bad_request');
    return fromUrl;
  }

  private async rpc(service: string, method: string, body: unknown) {
    const host = this.config.url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    try {
      return await fetch(`${host}/twirp/livekit.${service}/${method}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (cause) {
      throw new VoiceError(`LiveKit unreachable: ${(cause as Error).message}`, 'network', true);
    }
  }

  /** A short-lived admin token. LiveKit's server API is plain JWT over HTTPS. */
  private token(): string {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const header = encode({ alg: 'HS256', typ: 'JWT' });
    const payload = encode({
      iss: this.config.apiKey,
      sub: 'attendance-platform',
      nbf: now - 10,
      exp: now + 300,
      video: { roomCreate: true, roomList: true, roomAdmin: true },
      sip: { admin: true, call: true },
    });
    const signature = crypto
      .createHmac('sha256', this.config.apiSecret)
      .update(`${header}.${payload}`)
      .digest('base64url');
    return `${header}.${payload}.${signature}`;
  }
}
