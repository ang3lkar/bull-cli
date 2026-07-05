import { describe, expect, it } from 'vitest';
import { connectionFromUrl } from '../../src/config.js';

describe('connectionFromUrl', () => {
  it('parses a plain host:port URL with defaults', () => {
    expect(connectionFromUrl('redis://localhost:6379')).toEqual({
      host: 'localhost',
      port: 6379,
      db: 0,
    });
  });

  it('defaults the port when omitted', () => {
    expect(connectionFromUrl('redis://localhost')).toEqual({
      host: 'localhost',
      port: 6379,
      db: 0,
    });
  });

  it('parses a password-only auth URL', () => {
    expect(connectionFromUrl('redis://:secret@host:6379')).toEqual({
      host: 'host',
      port: 6379,
      db: 0,
      password: 'secret',
    });
  });

  it('parses a username+password auth URL', () => {
    expect(connectionFromUrl('redis://alice:secret@host:6379')).toEqual({
      host: 'host',
      port: 6379,
      db: 0,
      username: 'alice',
      password: 'secret',
    });
  });

  it('parses a db path segment', () => {
    expect(connectionFromUrl('redis://host:6379/3')).toEqual({
      host: 'host',
      port: 6379,
      db: 3,
    });
  });

  it('parses auth plus a db path segment together', () => {
    expect(connectionFromUrl('redis://alice:secret@host:6379/2')).toEqual({
      host: 'host',
      port: 6379,
      db: 2,
      username: 'alice',
      password: 'secret',
    });
  });

  it('defaults db to 0 when the path is empty', () => {
    expect(connectionFromUrl('redis://host:6379/')).toEqual({
      host: 'host',
      port: 6379,
      db: 0,
    });
  });

  it('decodes percent-encoded credentials', () => {
    expect(connectionFromUrl('redis://user%20name:p%40ss@host:6379')).toEqual({
      host: 'host',
      port: 6379,
      db: 0,
      username: 'user name',
      password: 'p@ss',
    });
  });

  it('enables tls for a rediss:// URL', () => {
    expect(connectionFromUrl('rediss://host:6380/2')).toEqual({
      host: 'host',
      port: 6380,
      db: 2,
      tls: {},
    });
  });

  it('does not set tls for a plain redis:// URL', () => {
    expect(connectionFromUrl('redis://host:6379')).not.toHaveProperty('tls');
  });

  it('strips brackets from an IPv6 host', () => {
    expect(connectionFromUrl('redis://[::1]:6379')).toEqual({
      host: '::1',
      port: 6379,
      db: 0,
    });
  });

  it('strips brackets from an IPv6 host on a rediss:// URL with auth and db', () => {
    expect(connectionFromUrl('rediss://alice:secret@[2001:db8::1]:6380/3')).toEqual({
      host: '2001:db8::1',
      port: 6380,
      db: 3,
      username: 'alice',
      password: 'secret',
      tls: {},
    });
  });
});
