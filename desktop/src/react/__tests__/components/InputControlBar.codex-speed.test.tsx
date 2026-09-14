// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InputControlBar } from '../../components/input/InputControlBar';

vi.mock('../../components/input/PlanModeButton', () => ({
  PlanModeButton: () => React.createElement('button', { type: 'button' }, 'plan'),
}));

vi.mock('../../components/input/ContextRing', () => ({
  ContextRing: () => React.createElement('span', null, 'context'),
}));

vi.mock('../../components/input/CodexSpeedButton', () => ({
  CodexSpeedButton: () => React.createElement('button', { type: 'button' }, 'codex-speed'),
}));

vi.mock('../../components/input/OauthAccountButton', () => ({
  OauthAccountButton: () => React.createElement('button', { type: 'button' }, 'oauth-account'),
}));

vi.mock('../../components/input/ThinkingLevelButton', () => ({
  ThinkingLevelButton: () => React.createElement('button', { type: 'button' }, 'thinking'),
}));

vi.mock('../../components/input/ModelSelector', () => ({
  ModelSelector: () => React.createElement('button', { type: 'button' }, 'model'),
}));

vi.mock('../../components/input/SendButton', () => ({
  SendButton: () => React.createElement('button', { type: 'button' }, 'send'),
}));

function renderBar(overrides: Partial<React.ComponentProps<typeof InputControlBar>> = {}) {
  return render(<InputControlBar
    t={(key) => key}
    onAttach={vi.fn()}
    slashBtnRef={{ current: null }}
    onSlashToggle={vi.fn()}
    permissionMode="ask"
    onPermissionModeChange={vi.fn()}
    planModeLocked={false}
    showThinking={true}
    thinkingLevel="medium"
    onThinkingChange={vi.fn()}
    availableThinkingLevels={['off', 'medium', 'high']}
    models={[]}
    sessionModel={undefined}
    isStreaming={false}
    hasInput={false}
    canSend={false}
    showAudioInput={false}
    audioRecordingActive={false}
    audioRecordingBusy={false}
    onAudioToggle={vi.fn()}
    onSend={vi.fn()}
    onSteer={vi.fn()}
    onStop={vi.fn()}
    {...overrides}
  />);
}

describe('InputControlBar Codex speed', () => {
  afterEach(() => cleanup());

  it('places the speed button to the left of thinking for GPT OAuth', () => {
    renderBar({
      sessionModel: {
        id: 'gpt-6-astra',
        name: 'GPT-6 Astra',
        provider: 'openai-codex-oauth',
      },
    });

    const speed = screen.getByText('codex-speed');
    const thinking = screen.getByText('thinking');
    expect(speed.compareDocumentPosition(thinking) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('hides the speed button for non-Codex providers', () => {
    renderBar({
      sessionModel: {
        id: 'grok-4.6',
        name: 'Grok 4.6',
        provider: 'xai-oauth',
      },
    });

    expect(screen.queryByText('codex-speed')).toBeNull();
    expect(screen.getByText('oauth-account')).toBeTruthy();
    expect(screen.getByText('thinking')).toBeTruthy();
  });

  it('still shows the speed button when thinking is hidden', () => {
    renderBar({
      showThinking: false,
      models: [{
        id: 'gpt-6-astra',
        name: 'GPT-6 Astra',
        provider: 'openai-codex-oauth',
        isCurrent: true,
      }],
    });

    expect(screen.getByText('codex-speed')).toBeTruthy();
    expect(screen.queryByText('thinking')).toBeNull();
  });
});
