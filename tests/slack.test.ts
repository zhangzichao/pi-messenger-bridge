import { describe, expect, it, vi } from 'vitest';
import { SlackProvider } from '../src/transports/slack';

describe('SlackProvider logger notifications', () => {
  it('routes websocket timeout warnings to the injected notifier', () => {
    const notify = vi.fn();
    const provider = new SlackProvider(
      { botToken: 'xoxb-test', appToken: 'xapp-test' },
      {} as any,
      { notify },
    );

    const logger = (provider as any).createLogger('warn');
    logger.setName('socket-mode:SlackWebSocket:0');
    logger.warn("A pong wasn't received from the server before the timeout of 5000ms!");

    expect(notify).toHaveBeenCalledWith(
      '⚠️ Slack websocket connection looks unstable. Reconnecting automatically...',
      'warning',
    );
  });

  it('rate limits repeated websocket notifications', () => {
    const notify = vi.fn();
    const provider = new SlackProvider(
      { botToken: 'xoxb-test', appToken: 'xapp-test' },
      {} as any,
      { notify },
    );

    const logger = (provider as any).createLogger('warn');
    logger.setName('socket-mode:SlackWebSocket:0');

    logger.warn("A pong wasn't received from the server before the timeout of 5000ms!");
    logger.warn("A ping wasn't received from the server before the timeout of 30000ms!");

    expect(notify).toHaveBeenCalledTimes(1);
  });
});
