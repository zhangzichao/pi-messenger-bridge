import { describe, expect, it } from 'vitest';
import type { ExternalMessage } from '../src/types';
import type { ITransportProvider } from '../src/transports/interface';
import { TransportManager } from '../src/transports/manager';

class FakeTransport implements ITransportProvider {
  readonly type: string;
  isConnected: boolean;
  connectCalls = 0;
  disconnectCalls = 0;

  constructor(
    type: string,
    private readonly behavior: {
      initiallyConnected?: boolean;
      failOnConnect?: boolean;
    } = {},
  ) {
    this.type = type;
    this.isConnected = behavior.initiallyConnected ?? false;
  }

  async connect(): Promise<void> {
    this.connectCalls++;
    if (this.behavior.failOnConnect) {
      throw new Error(`boom-${this.type}`);
    }
    this.isConnected = true;
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls++;
    this.isConnected = false;
  }

  async sendMessage(_chatId: string, _text: string): Promise<void> {}
  async sendTyping(_chatId: string): Promise<void> {}
  onMessage(_handler: (message: ExternalMessage) => void): void {}
  onError(_handler: (error: Error) => void): void {}
}

describe('TransportManager.connectAll', () => {
  it('rolls back transports started by the failed connect attempt', async () => {
    const manager = new TransportManager();
    const telegram = new FakeTransport('telegram');
    const slack = new FakeTransport('slack', { failOnConnect: true });

    manager.addTransport(telegram);
    manager.addTransport(slack);

    await expect(manager.connectAll()).rejects.toThrow('slack connection failed: boom-slack');

    expect(telegram.connectCalls).toBe(1);
    expect(telegram.disconnectCalls).toBe(1);
    expect(telegram.isConnected).toBe(false);
    expect(slack.disconnectCalls).toBe(0);
  });

  it('does not disconnect transports that were already connected before the call', async () => {
    const manager = new TransportManager();
    const telegram = new FakeTransport('telegram', { initiallyConnected: true });
    const slack = new FakeTransport('slack', { failOnConnect: true });

    manager.addTransport(telegram);
    manager.addTransport(slack);

    await expect(manager.connectAll()).rejects.toThrow('slack connection failed: boom-slack');

    expect(telegram.connectCalls).toBe(1);
    expect(telegram.disconnectCalls).toBe(0);
    expect(telegram.isConnected).toBe(true);
  });
});
