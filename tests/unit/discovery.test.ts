import { describe, expect, it } from 'vitest';
import { queueNameFromMetaKey } from '../../src/core/discovery.js';

describe('queueNameFromMetaKey', () => {
  it('strips the leading bull: and trailing :meta', () => {
    expect(queueNameFromMetaKey('bull:emailQ:meta')).toBe('emailQ');
  });

  it('preserves colons inside the queue name', () => {
    expect(queueNameFromMetaKey('bull:billing:invoices:meta')).toBe('billing:invoices');
  });

  it('returns null for a degenerate empty name (bull::meta)', () => {
    expect(queueNameFromMetaKey('bull::meta')).toBeNull();
  });

  it('returns null for a key too short to hold both affixes distinctly', () => {
    expect(queueNameFromMetaKey('bull:meta')).toBeNull();
  });

  it('returns null when the key lacks the bull: prefix', () => {
    expect(queueNameFromMetaKey('other:emailQ:meta')).toBeNull();
  });

  it('returns null when the key lacks the :meta suffix', () => {
    expect(queueNameFromMetaKey('bull:emailQ:events')).toBeNull();
  });

  it('returns null for an unrelated key', () => {
    expect(queueNameFromMetaKey('user:1')).toBeNull();
  });

  it('returns null for a key that only superficially resembles the pattern', () => {
    expect(queueNameFromMetaKey('bullish:x:meta')).toBeNull();
  });
});
