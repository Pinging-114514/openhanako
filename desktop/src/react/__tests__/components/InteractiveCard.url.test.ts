import { describe, expect, it } from 'vitest';
import { buildInteractiveCardFrameSrc } from '../../components/chat/InteractiveCard';

describe('buildInteractiveCardFrameSrc', () => {
  it('appends a version query on an absolute card URL', () => {
    expect(buildInteractiveCardFrameSrc('https://hana.example/api/cards/c_1', 3)).toBe(
      'https://hana.example/api/cards/c_1?v=3',
    );
  });

  it('attaches a remote iframe ticket without dropping existing query params', () => {
    expect(buildInteractiveCardFrameSrc(
      'https://hana.example/api/cards/c_1?token=loop',
      2,
      'ticket-1',
    )).toBe('https://hana.example/api/cards/c_1?token=loop&v=2&cardIframeTicket=ticket-1');
  });
});
