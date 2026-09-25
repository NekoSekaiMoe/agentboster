import { describe, expect, it } from 'vitest';
import { EventStream } from './event-stream.ts';

describe('EventStream (pi #9055 FifoQueue port)', () => {
  it('delivers buffered events in FIFO order', async () => {
    const stream = new EventStream<string, string>(
      (event) => event === 'done',
      () => 'final',
    );
    for (let i = 0; i < 1000; i++) stream.push(`event-${i}`);
    stream.push('done');

    const collected: string[] = [];
    for await (const event of stream) {
      if (event === 'done') break;
      collected.push(event);
    }
    expect(collected).toHaveLength(1000);
    expect(collected[0]).toBe('event-0');
    expect(collected[999]).toBe('event-999');
    expect(await stream.result()).toBe('final');
  });

  it('resolves waiting consumers immediately in FIFO order', async () => {
    const stream = new EventStream<string, string>(
      (event) => event === 'done',
      () => 'final',
    );
    const first = (async () => {
      for await (const _event of stream) return 'first-done';
      return 'unreachable';
    })();
    await new Promise((resolve) => setTimeout(resolve, 0));
    stream.push('wake');
    expect(await first).toBe('first-done');
    stream.end('final');
  });

  it('end() terminates all waiting consumers', async () => {
    const stream = new EventStream<number, string>(
      (event) => event < 0,
      () => 'final',
    );
    let iterations = 0;
    const consumer = (async () => {
      for await (const _event of stream) iterations++;
    })();
    stream.push(1);
    stream.push(2);
    stream.end('final');
    await consumer;
    expect(iterations).toBe(2);
    expect(await stream.result()).toBe('final');
  });
});
