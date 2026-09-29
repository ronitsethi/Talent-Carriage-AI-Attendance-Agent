/**
 * The voices the talking agent can use.
 *
 * Sarvam's Indian voices, grouped the way somebody choosing one actually
 * thinks: who is this going to sound like. The customer-care voices are warmer
 * and slower than the content ones, which is what an attendance call wants.
 *
 * `npm run voices` speaks the real opening line in each, because a name tells
 * you nothing about how a voice sounds.
 */
export type AgentVoice = {
  id: string;
  label: string;
  gender: 'female' | 'male';
};

export const AGENT_VOICES: AgentVoice[] = [
  { id: 'ritu', label: 'Ritu', gender: 'female' },
  { id: 'pooja', label: 'Pooja', gender: 'female' },
  { id: 'priya', label: 'Priya', gender: 'female' },
  { id: 'kavya', label: 'Kavya', gender: 'female' },
  { id: 'simran', label: 'Simran', gender: 'female' },
  { id: 'ishita', label: 'Ishita', gender: 'female' },
  { id: 'shreya', label: 'Shreya', gender: 'female' },
  { id: 'rahul', label: 'Rahul', gender: 'male' },
  { id: 'amit', label: 'Amit', gender: 'male' },
  { id: 'dev', label: 'Dev', gender: 'male' },
  { id: 'rohan', label: 'Rohan', gender: 'male' },
  { id: 'shubh', label: 'Shubh', gender: 'male' },
  { id: 'manan', label: 'Manan', gender: 'male' },
  { id: 'sumit', label: 'Sumit', gender: 'male' },
];

export const DEFAULT_AGENT_VOICE = 'ritu';

export function isAgentVoice(value: string): boolean {
  return AGENT_VOICES.some((voice) => voice.id === value);
}
