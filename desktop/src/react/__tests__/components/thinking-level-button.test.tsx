// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { ThinkingLevelButton } from '../../components/input/ThinkingLevelButton';
import { useStore } from '../../stores';

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
}));

vi.mock('../../hooks/use-config', () => ({
  invalidateConfigCache: vi.fn(),
}));

import { createTestTranslator } from '../helpers/i18n-test-strings';

const testT = createTestTranslator();

vi.mock('../../hooks/use-i18n', () => ({
  useI18n: () => ({ t: testT }),
}));

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

function optionForText(text: string): HTMLElement {
  const option = screen.getByText(text).closest('[role="option"]');
  if (!(option instanceof HTMLElement)) {
    throw new Error(`Option not found for ${text}`);
  }
  return option;
}

describe('ThinkingLevelButton', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hanaFetch).mockReset();
    useStore.setState({
      currentSessionPath: null,
      pendingNewSession: true,
      activeServerConnectionId: 'local',
      activeServerConnection: null,
    } as never);
  });

  it('saves thinking changes to the current session when a session is active', async () => {
    vi.mocked(hanaFetch).mockResolvedValueOnce(jsonResponse({ thinkingLevel: 'high' }));
    useStore.setState({
      currentSessionPath: '/session/a.jsonl',
      pendingNewSession: false,
    } as never);
    const onChange = vi.fn();

    const { container } = render(<ThinkingLevelButton level="medium" onChange={onChange} availableLevels={['off', 'medium', 'high', 'max']} />);
    fireEvent.click(container.querySelector('button') as HTMLButtonElement);
    fireEvent.click(optionForText('深度'));

    await waitFor(() => {
      expect(hanaFetch).toHaveBeenCalledWith('/api/session-thinking-level', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ sessionPath: '/session/a.jsonl', level: 'high' }),
      }));
    });
    expect(onChange).toHaveBeenCalledWith('high');
  });

  it('saves pending new-session thinking changes as the model default draft', async () => {
    vi.mocked(hanaFetch).mockResolvedValueOnce(jsonResponse({ ok: true, thinkingLevel: 'high' }));
    const onChange = vi.fn();

    const { container } = render(<ThinkingLevelButton level="medium" onChange={onChange} availableLevels={['off', 'medium', 'high']} />);
    fireEvent.click(container.querySelector('button') as HTMLButtonElement);
    fireEvent.click(optionForText('深度'));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('high'));
    expect(hanaFetch).toHaveBeenCalledWith('/api/session-thinking-level', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ level: 'high' }),
    }));
    expect(onChange).toHaveBeenCalledWith('high');
  });

  it('surfaces a failed save and releases the control instead of silently remaining stuck', async () => {
    const toast = vi.spyOn(useStore.getState(), 'addToast').mockImplementation(() => 'toast');
    vi.mocked(hanaFetch).mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ ok: false, error: 'session not found' }) } as Response);
    useStore.setState({ currentSessionPath: '/session/stopped.jsonl', pendingNewSession: false } as never);
    const onChange = vi.fn();
    const view = render(<ThinkingLevelButton level="medium" onChange={onChange} availableLevels={['medium', 'high']} />);
    const button = view.container.querySelector('button') as HTMLButtonElement;
    fireEvent.click(button); fireEvent.click(optionForText('深度'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('session not found', 'error', 5000));
    expect(button.disabled).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    vi.mocked(hanaFetch).mockResolvedValueOnce(jsonResponse({ ok: true, thinkingLevel: 'high' }));
    fireEvent.click(button); fireEvent.click(optionForText('深度'));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('high'));
  });

  it('does not apply a late response to another session or clear its new save state', async () => {
    const pending: Array<(response: Response) => void> = [];
    vi.mocked(hanaFetch).mockImplementation(() => new Promise(resolve => pending.push(resolve)));
    useStore.setState({ currentSessionPath: '/session/a.jsonl', pendingNewSession: false } as never);
    const onChange = vi.fn();
    const view = render(<ThinkingLevelButton level="medium" onChange={onChange} availableLevels={['medium', 'high']} />);
    const button = view.container.querySelector('button') as HTMLButtonElement;
    fireEvent.click(button); fireEvent.click(optionForText('深度'));
    expect(button.disabled).toBe(true);
    act(() => useStore.setState({ currentSessionPath: '/session/b.jsonl' } as never));
    expect(button.disabled).toBe(false);
    fireEvent.click(button); fireEvent.click(optionForText('深度'));
    expect(pending).toHaveLength(2);
    await act(async () => { pending[0](jsonResponse({ ok: true, thinkingLevel: 'high' })); });
    expect(onChange).not.toHaveBeenCalled();
    expect(button.disabled).toBe(true);
    await act(async () => { pending[1](jsonResponse({ ok: true, thinkingLevel: 'high' })); });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(false);
    expect(hanaFetch).toHaveBeenLastCalledWith('/api/session-thinking-level', expect.objectContaining({ body: JSON.stringify({ sessionPath: '/session/b.jsonl', level: 'high' }) }));
  });

  it('ignores completion after the input control unmounts', async () => {
    const pending: { resolve?: (response: Response) => void } = {};
    vi.mocked(hanaFetch).mockImplementationOnce(() => new Promise(resolve => { pending.resolve = resolve; }));
    const onChange = vi.fn();
    const view = render(<ThinkingLevelButton level="medium" onChange={onChange} availableLevels={['medium', 'high']} />);
    fireEvent.click(view.container.querySelector('button') as HTMLButtonElement);
    fireEvent.click(optionForText('深度'));
    view.unmount();
    await act(async () => { pending.resolve?.(jsonResponse({ ok: true, thinkingLevel: 'high' })); });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows Medium instead of Auto for legacy auto state', () => {
    const { container } = render(<ThinkingLevelButton level="auto" onChange={vi.fn()} availableLevels={['off', 'medium', 'high']} />);

    fireEvent.click(container.querySelector('button') as HTMLButtonElement);

    expect(screen.queryByRole('option', { name: /auto/i })).toBeNull();
    expect(screen.getByRole('option', { name: /中等/ })).toBeTruthy();
  });

  it('hides the xhigh level when the model does not support it', () => {
    const { container } = render(<ThinkingLevelButton level="off" onChange={vi.fn()} availableLevels={['off', 'medium', 'high']} />);

    fireEvent.click(container.querySelector('button') as HTMLButtonElement);

    expect(screen.getByRole('option', { name: /深度/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'xhigh' })).toBeNull();
  });

  it('shows and saves Max for models that support the deep thinking tier', async () => {
    vi.mocked(hanaFetch).mockResolvedValueOnce(jsonResponse({ ok: true, thinkingLevel: 'max' }));
    const onChange = vi.fn();

    const { container } = render(<ThinkingLevelButton level="medium" onChange={onChange} availableLevels={['off', 'medium', 'high', 'max']} />);
    fireEvent.click(container.querySelector('button') as HTMLButtonElement);

    expect(screen.getByRole('option', { name: /Max/ })).toBeTruthy();
    expect(screen.getByText('最高推理')).toBeTruthy();
    expect(screen.queryByRole('option', { name: '超高' })).toBeNull();

    fireEvent.click(optionForText('Max'));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('max'));
    expect(hanaFetch).toHaveBeenCalledWith('/api/session-thinking-level', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ level: 'max' }),
    }));
  });

  it('does not render a trailing checkmark for the selected thinking level', () => {
    const { container } = render(<ThinkingLevelButton level="high" onChange={vi.fn()} availableLevels={['off', 'medium', 'high', 'max']} />);

    fireEvent.click(container.querySelector('button') as HTMLButtonElement);

    const selected = optionForText('深度');
    expect(selected.getAttribute('aria-selected')).toBe('true');
    expect(selected.querySelector('[data-select-check]')).toBeNull();
  });
});
