/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserChoiceCard } from '../../components/chat/UserChoiceCard';

const hanaFetch = vi.fn(async () => new Response('{}', { status: 200 }));

vi.mock('../../hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: (...args: unknown[]) => hanaFetch(...args),
}));

const options = [
  { id: 'plan_a', label: 'Plan A', description: 'Ship now' },
  { id: 'plan_b', label: 'Plan B' },
];

describe('UserChoiceCard', () => {
  beforeEach(() => {
    hanaFetch.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('submits a single selected option', async () => {
    render(
      <UserChoiceCard
        confirmId="c1"
        question="Which plan?"
        options={options}
        allowMultiple={false}
        status="pending"
      />,
    );

    fireEvent.click(screen.getByRole('radio', { name: /Plan A/ }));
    fireEvent.click(screen.getByRole('button', { name: 'chat.askUser.confirm' }));

    await waitFor(() => expect(hanaFetch).toHaveBeenCalled());
    const [, init] = hanaFetch.mock.calls[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      action: 'confirmed',
      value: { selected: ['plan_a'] },
    });
  });

  it('submits multiple options plus Other text', async () => {
    render(
      <UserChoiceCard
        confirmId="c2"
        question="Which plan?"
        options={options}
        allowMultiple
        status="pending"
      />,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: /Plan A/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Plan B/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'chat.askUser.other' }));
    fireEvent.change(screen.getByPlaceholderText('chat.askUser.otherPlaceholder'), {
      target: { value: 'Plan C' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'chat.askUser.confirm' }));

    await waitFor(() => expect(hanaFetch).toHaveBeenCalled());
    const [, init] = hanaFetch.mock.calls[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      action: 'confirmed',
      value: { selected: ['plan_a', 'plan_b'], free_text: 'Plan C' },
    });
  });

  it('skips without selecting', async () => {
    render(
      <UserChoiceCard
        confirmId="c3"
        question="Which plan?"
        options={options}
        allowMultiple={false}
        status="pending"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'chat.askUser.skip' }));
    await waitFor(() => expect(hanaFetch).toHaveBeenCalled());
    const [, init] = hanaFetch.mock.calls[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      action: 'rejected',
      value: { selected: [], skipped: true },
    });
  });
});
