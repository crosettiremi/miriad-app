import {
  mkdirSync,
  writeFileSync,
  renameSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
/** Final frames survive reconnects and workspace checkpoints until PostgreSQL acknowledges them. */
export class FrameOutbox {
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  private path(id: string) {
    return join(
      this.directory,
      createHash('sha256').update(id).digest('hex') + '.json',
    );
  }
  put(operationId: string, frame: unknown) {
    const target = this.path(operationId);
    const data = JSON.stringify({ operationId, frame });
    if (Buffer.byteLength(data) > 1024 * 1024)
      throw new Error('Final runtime frame exceeds 1 MiB');
    if (this.pending().length >= 1000)
      throw new Error('Runtime outbox full; database delivery must recover');
    writeFileSync(target + '.tmp', data, { mode: 0o600 });
    renameSync(target + '.tmp', target);
  }
  ack(operationId: string) {
    try {
      unlinkSync(this.path(operationId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  pending(): Array<{ operationId: string; frame: unknown }> {
    return readdirSync(this.directory)
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        JSON.parse(readFileSync(join(this.directory, name), 'utf8')),
      );
  }
}
