import { describe, it, expect } from 'vitest';
import { extractDisplayName, extractSlug } from './webid';

describe('extractDisplayName', () => {
  it.each([
    ['https://damien.solidcommunity.net/profile/card#me', 'damien'],
    ['https://id.inrupt.com/damien', 'damien'],
    ['https://pod.example.com/johndoe/profile/card#me', 'johndoe'],
  ])('%s → %s', (webId, name) => {
    expect(extractDisplayName(webId)).toBe(name);
  });

  it('falls back to "User" for something that is not a WebID', () => {
    expect(extractDisplayName('not a url')).toBe('User');
    expect(extractDisplayName('https://example.com/')).toBe('User');
  });
});

describe('extractSlug', () => {
  it('makes a booking-link-safe slug', () => {
    expect(extractSlug('https://id.inrupt.com/Jane.Doe_99')).toBe('jane-doe-99');
  });

  it('caps the length and never returns an empty slug', () => {
    expect(extractSlug(`https://id.inrupt.com/${'a'.repeat(50)}`)).toHaveLength(30);
    expect(extractSlug('https://id.inrupt.com/---')).toBe('user');
  });
});
