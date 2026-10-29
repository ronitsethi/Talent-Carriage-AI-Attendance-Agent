/**
 * The voices the talking agent can use.
 *
 * Sarvam's Bulbul v4 Flash voices made for Hindi and English mixed ("enhi"),
 * because a call moves between the two and one voice has to carry both. v4
 * Flash is a third of v3's price per character. Its voices are not v3's: each
 * is named for a person, a language and a style.
 *
 * `npm run voices` speaks the real opening line in each, because a name tells
 * you nothing about how a voice sounds.
 */
export type AgentVoice = {
  id: string;
  label: string;
  gender: 'female' | 'male';
};

/** The Sarvam model every voice here belongs to - the keypad line's clips as well as the talking agent. */
export const AGENT_VOICE_MODEL = 'bulbul:v4-flash';

export const AGENT_VOICES: AgentVoice[] = [
  { id: 'simran_enhi_customer', label: 'Simran', gender: 'female' },
  { id: 'ishita_enhi_customer', label: 'Ishita', gender: 'female' },
  { id: 'shalini_enhi_customer', label: 'Shalini', gender: 'female' },
  { id: 'sunny_enhi_customer', label: 'Sunny', gender: 'male' },
  { id: 'shubh_enhi_banking', label: 'Shubh', gender: 'male' },
];

export const DEFAULT_AGENT_VOICE = 'simran_enhi_customer';

export function isAgentVoice(value: string): boolean {
  return AGENT_VOICES.some((voice) => voice.id === value);
}

/** The v3 voices settings held before, by gender, so one left over still speaks as the same kind of person. */
const OLD_MALE_VOICES = new Set(['rahul', 'amit', 'dev', 'rohan', 'shubh', 'manan', 'sumit']);

/**
 * The voice to speak in. A v3 name - left in settings, or from before the
 * switch - is not a v4 voice, and Sarvam refuses it; it becomes this list's
 * voice of the same gender.
 */
export function agentVoice(id: string | null | undefined): string {
  if (id && isAgentVoice(id)) return id;
  return id && OLD_MALE_VOICES.has(id) ? 'sunny_enhi_customer' : DEFAULT_AGENT_VOICE;
}

/**
 * Whether the voice is a woman's or a man's. Hindi says so in the verb - "main
 * samajh gayi" or "samajh gaya" - so the words must match the voice speaking them.
 */
export function agentGender(id: string | null | undefined): AgentVoice['gender'] {
  return AGENT_VOICES.find((voice) => voice.id === agentVoice(id))?.gender ?? 'female';
}
