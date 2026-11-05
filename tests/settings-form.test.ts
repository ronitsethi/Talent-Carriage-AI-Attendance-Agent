import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Saving Settings writes every field, so a box missing from the page overwrites
 * the customer's value. Every field it reads must be on the page.
 */
describe('the settings form', () => {
  it('has a box for everything saving it writes', () => {
    const actions = fs.readFileSync('src/app/actions.ts', 'utf8');
    const save = actions.slice(actions.indexOf('function updateSettings'));
    const body = save.slice(0, save.indexOf('\nexport '));
    const fields = [...body.matchAll(/(?:int|bool|formData\.get)\('(\w+)'/g)].map((match) => match[1]!);
    const page = ['src/app/(app)/settings/page.tsx', 'src/components/follow-up-contacts.tsx'].map((file) => fs.readFileSync(file, 'utf8')).join('');

    expect(fields.length).toBeGreaterThan(5);
    expect(fields.filter((field) => !page.includes(`name="${field}"`))).toEqual([]);
  });
});
