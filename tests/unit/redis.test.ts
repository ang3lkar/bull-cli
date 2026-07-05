import { describe, expect, it } from 'vitest';
import { createRedisClient } from '../../src/core/redis.js';
import type { ConnectionStatus } from '../../src/core/types.js';

describe('createRedisClient', () => {
  it('maps connecting/ready/error events to typed statuses (no I/O, lazyConnect)', () => {
    const seen: ConnectionStatus[] = [];
    const url = 'redis://localhost:6379';
    const client = createRedisClient(url, (status) => seen.push(status));

    client.emit('connecting');
    client.emit('ready');
    client.emit('error', new Error('boom'));

    client.disconnect();

    expect(seen).toEqual([
      { state: 'connecting' },
      { state: 'ready' },
      { state: 'error', url, message: 'boom' },
    ]);
  });

  it('does not throw when no onStatus callback is provided', () => {
    const client = createRedisClient('redis://localhost:6379');
    expect(() => client.emit('error', new Error('boom'))).not.toThrow();
    client.disconnect();
  });

  it('falls back to nested error messages for an AggregateError with an empty message', () => {
    const seen: ConnectionStatus[] = [];
    const url = 'redis://localhost:6379';
    const client = createRedisClient(url, (status) => seen.push(status));

    const aggregate = new AggregateError(
      [
        new Error('connect ECONNREFUSED ::1:9999'),
        new Error('connect ECONNREFUSED 127.0.0.1:9999'),
      ],
      '',
    );
    client.emit('error', aggregate);

    client.disconnect();

    expect(seen).toEqual([
      {
        state: 'error',
        url,
        message: 'connect ECONNREFUSED ::1:9999; connect ECONNREFUSED 127.0.0.1:9999',
      },
    ]);
  });

  it('falls back to an errno code when message and nested errors are both absent', () => {
    const seen: ConnectionStatus[] = [];
    const url = 'redis://localhost:6379';
    const client = createRedisClient(url, (status) => seen.push(status));

    const error = new Error('');
    (error as NodeJS.ErrnoException).code = 'ECONNRESET';
    client.emit('error', error);

    client.disconnect();

    expect(seen).toEqual([{ state: 'error', url, message: 'ECONNRESET' }]);
  });
});
