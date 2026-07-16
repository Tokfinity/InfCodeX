import { describe, expect, it } from 'vitest';

import {
  parseOAuthEndpointUrl,
  parseOAuthIssuerIdentifier,
  parseOAuthResourceIdentifier,
} from './security.js';

describe('A2A OAuth URI validation', () => {
  it('preserves the exact trimmed issuer identifier without slash normalization', () => {
    expect(parseOAuthIssuerIdentifier('  https://identity.example.com  ', 'issuer'))
      .toBe('https://identity.example.com');
    expect(parseOAuthIssuerIdentifier('https://identity.example.com/', 'issuer'))
      .toBe('https://identity.example.com/');
  });

  it.each([
    'http://identity.example.com',
    'file:///identity',
    'https://user:secret@identity.example.com',
    'https://@identity.example.com',
    'https://identity.example.com?tenant=one',
    'https://identity.example.com?',
    'https://identity.example.com#fragment',
    'https://identity.example.com#',
  ])('rejects an unsafe issuer identifier: %s', (value) => {
    expect(() => parseOAuthIssuerIdentifier(value, 'issuer')).toThrow(/issuer/i);
  });

  it('accepts exact loopback HTTP issuer identifiers for local development', () => {
    expect(parseOAuthIssuerIdentifier('http://[::1]:8080/issuer', 'issuer'))
      .toBe('http://[::1]:8080/issuer');
  });

  it('accepts endpoint queries but rejects unsafe endpoint components and transports', () => {
    expect(parseOAuthEndpointUrl('https://identity.example.com/token?tenant=one', 'endpoint').href)
      .toBe('https://identity.example.com/token?tenant=one');
    expect(parseOAuthEndpointUrl('http://127.0.0.1:8080/token?', 'endpoint').href)
      .toBe('http://127.0.0.1:8080/token?');
    for (const value of [
      'http://identity.example.com/token',
      'file:///token',
      'https://user:secret@identity.example.com/token',
      'https://@identity.example.com/token',
      'https://identity.example.com/token#fragment',
      'https://identity.example.com/token#',
    ]) {
      expect(() => parseOAuthEndpointUrl(value, 'endpoint')).toThrow(/endpoint/i);
    }
  });

  it('accepts absolute URI resource indicators and rejects fragments', () => {
    expect(parseOAuthResourceIdentifier(' urn:example:a2a:agent ', 'resource'))
      .toBe('urn:example:a2a:agent');
    expect(parseOAuthResourceIdentifier('https://agent.example.com?tenant=one', 'resource'))
      .toBe('https://agent.example.com?tenant=one');
    for (const value of [
      '/relative',
      'urn:example:a2a#fragment',
      'urn:example:a2a#',
    ]) {
      expect(() => parseOAuthResourceIdentifier(value, 'resource')).toThrow(/resource/i);
    }
  });
});
