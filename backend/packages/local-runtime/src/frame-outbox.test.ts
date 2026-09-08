import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrameOutbox } from './frame-outbox.js';
it('recovers final frames after restart and removes only acknowledged frames', () => {
  const dir = mkdtempSync(join(tmpdir(), 'miriad-outbox-'));
  try {
    const a = new FrameOutbox(dir);
    a.put('runtime:message-a', { frame: 'a' });
    a.put('runtime:message-b', { frame: 'b' });
    const b = new FrameOutbox(dir);
    expect(b.pending()).toHaveLength(2);
    b.ack('runtime:message-a');
    b.ack('runtime:message-a');
    expect(new FrameOutbox(dir).pending()).toEqual([
      { operationId: 'runtime:message-b', frame: { frame: 'b' } },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
