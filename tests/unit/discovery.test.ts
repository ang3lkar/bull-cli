import { describe, expect, it } from 'vitest';
import { queueNameFromMetaKey } from '../../src/core/discovery.js';

describe('queueNameFromMetaKey', () => {
  it('strips the leading bull: and trailing :meta', () => {
    expect(queueNameFromMetaKey('bull:emailQ:meta', 'bull')).toBe('emailQ');
  });

  it('preserves colons inside the queue name', () => {
    expect(queueNameFromMetaKey('bull:billing:invoices:meta', 'bull')).toBe('billing:invoices');
  });

  it('returns null for a degenerate empty name (bull::meta)', () => {
    expect(queueNameFromMetaKey('bull::meta', 'bull')).toBeNull();
  });

  it('returns null for a key too short to hold both affixes distinctly', () => {
    expect(queueNameFromMetaKey('bull:meta', 'bull')).toBeNull();
  });

  it('returns null when the key lacks the bull: prefix', () => {
    expect(queueNameFromMetaKey('other:emailQ:meta', 'bull')).toBeNull();
  });

  it('returns null when the key lacks the :meta suffix', () => {
    expect(queueNameFromMetaKey('bull:emailQ:events', 'bull')).toBeNull();
  });

  it('returns null for an unrelated key', () => {
    expect(queueNameFromMetaKey('user:1', 'bull')).toBeNull();
  });

  it('returns null for a key that only superficially resembles the pattern', () => {
    expect(queueNameFromMetaKey('bullish:x:meta', 'bull')).toBeNull();
  });

  it('uses a custom prefix to derive the queue name', () => {
    expect(queueNameFromMetaKey('myapp:emailQ:meta', 'myapp')).toBe('emailQ');
  });

  it('returns null when the key was written under a different prefix', () => {
    expect(queueNameFromMetaKey('bull:emailQ:meta', 'myapp')).toBeNull();
  });
});
