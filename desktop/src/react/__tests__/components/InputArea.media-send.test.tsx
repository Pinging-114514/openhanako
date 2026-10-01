// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputArea, resetFollowupSendRuntimeForTest } from '../../components/InputArea';
import { useStore } from '../../stores';

const mocks = vi.hoisted(() => ({
  clearContent: vi.fn(),
  ensureSession: vi.fn(),
  hanaFetch: vi.fn(),
  upsertOptimisticSessionFirstMessage: vi.fn(),
  wsSend: vi.fn(),
}));

vi.mock('@tiptap/react', () => ({
  useEditor: () => {
    const chain: Record<string, unknown> = {};
    chain.clearContent = vi.fn(() => chain);
    chain.deleteRange = vi.fn(() => chain);
    chain.insertContent = vi.fn(() => chain);
    chain.focus = vi.fn(() => chain);
    chain.run = vi.fn();
    return {
      commands: {
        focus: vi.fn(),
        clearContent: mocks.clearContent,
        scrollIntoView: vi.fn(),
        setContent: vi.fn(),
        insertContent: vi.fn(),
      },
      chain: () => chain,
      getText: () => '',
      getJSON: () => ({ type: 'doc', content: [] }),
      state: { tr: { setMeta: vi.fn(() => ({})) } },
      view: { dispatch: vi.fn() },
      on: vi.fn(),
      off: vi.fn(),
    };
  },
  EditorContent: () => React.createElement('div', { 'data-testid': 'editor' }),
}));

vi.mock('@tiptap/starter-kit', () => ({
  default: { configure: () => ({}) },
}));

vi.mock('@tiptap/extension-placeholder', () => ({
  default: { configure: () => ({}) },
}));

vi.mock('../../components/input/extensions/skill-badge', () => ({
  SkillBadge: {},
}));

import { createTestTranslator } from '../helpers/i18n-test-strings';

const testT = createTestTranslator();

vi.mock('../../hooks/use-i18n', () => ({
  useI18n: () => ({ t: testT }),
}));

vi.mock('../../hooks/use-config', () => ({
  fetchConfig: vi.fn(async () => ({})),
}));

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: (path: string, opts?: RequestInit) => mocks.hanaFetch(path, opts),
  hanaUrl: (path: string) => `http://127.0.0.1:3210${path}`,
}));

vi.mock('../../stores/session-actions', () => ({
  ensureSession: mocks.ensureSession,
  loadSessions: vi.fn(),
  upsertOptimisticSessionFirstMessage: mocks.upsertOptimisticSessionFirstMessage,
}));

vi.mock('../../stores/desk-actions', () => ({
  loadDeskFiles: vi.fn(),
  searchDeskFiles: vi.fn(async () => []),
  toggleJianSidebar: vi.fn(),
}));

vi.mock('../../services/websocket', () => ({
  getWebSocket: vi.fn(() => ({ send: mocks.wsSend })),
}));

vi.mock('../../MainContent', () => ({
  attachFilesFromPaths: vi.fn(),
}));

vi.mock('../../components/input/SlashCommandMenu', () => ({
  SlashCommandMenu: () => null,
}));

vi.mock('../../components/input/FileMentionMenu', () => ({
  FileMentionMenu: () => null,
}));

vi.mock('../../components/input/InputStatusBars', () => ({
  InputStatusBars: () => null,
}));

vi.mock('../../components/input/InputContextRow', () => ({
  InputContextRow: () => null,
}));

vi.mock('../../components/input/InputControlBar', () => ({
  InputControlBar: ({
    canSend,
    onSend,
    isStreaming,
    hasInput,
    onQueue,
    onStop,
    availableThinkingLevels,
    showAudioInput,
    onAudioToggle,
    audioRecordingActive,
  }: {
    canSend: boolean;
    onSend: () => void;
    isStreaming?: boolean;
    hasInput?: boolean;
    onQueue?: () => void;
    onStop?: () => void;
    availableThinkingLevels?: string[];
    showAudioInput?: boolean;
    onAudioToggle?: () => void;
    audioRecordingActive?: boolean;
  }) => React.createElement(
    React.Fragment,
    null,
    React.createElement(
      'button',
      {
        type: 'button',
        'data-testid': 'send',
        'data-thinking-levels': availableThinkingLevels?.join(','),
        disabled: isStreaming ? !hasInput : !canSend,
        onClick: isStreaming ? onQueue : onSend,
      },
      'send',
    ),
    showAudioInput
      ? React.createElement(
        'button',
        { type: 'button', 'data-testid': 'record-audio', onClick: onAudioToggle },
        audioRecordingActive ? 'stop' : 'record',
      )
      : null,
    isStreaming
      ? React.createElement('button', { type: 'button', 'data-testid': 'stop', onClick: onStop }, 'stop')
      : null,
  ),
}));

vi.mock('../../hooks/use-slash-items', () => ({
  useSkillSlashItems: () => [],
  useServerSlashCommandItems: () => [],
}));

vi.mock('../../utils/paste-upload-feedback', () => ({
  notifyPasteUploadFailure: vi.fn(),
}));

vi.mock('../../services/stream-resume', () => ({
  replayStreamResume: vi.fn(),
  isStreamResumeRebuilding: () => null,
  isStreamScopedMessage: () => false,
  updateSessionStreamMeta: vi.fn(),
}));

function seedSession() {
  useStore.setState({
    currentSessionPath: '/session/media.jsonl',
    currentSessionId: 'sess_media',
    currentAgentId: 'hana',
    sessions: [{
      path: '/session/media.jsonl',
      sessionId: 'sess_media',
      agentId: 'hana',
      agentName: 'Hana',
    }],
    sessionLocatorsById: { sess_media: { path: '/session/media.jsonl' } },
    connected: true,
    pendingNewSession: false,
    streamingSessions: [],
    inlineErrors: {},
    attachedFiles: [{
      fileId: 'sf_pasted',
      path: '/tmp/hana/session-files/pasted.png',
      name: 'pasted.png',
      isDirectory: false,
    }],
    attachedFilesBySession: {
      '/session/media.jsonl': [{
        fileId: 'sf_pasted',
        path: '/tmp/hana/session-files/pasted.png',
        name: 'pasted.png',
        isDirectory: false,
      }],
    },
    docContextAttached: false,
    quoteCandidate: null,
    quotedSelections: [],
    quotedSelection: null,
    models: [{
      id: 'deepseek-chat',
      provider: 'deepseek',
      name: 'DeepSeek Chat',
      input: ['text'],
      isCurrent: true,
    }],
    sessionModelsByPath: {},
    previewItems: [],
    previewOpen: false,
    chatSessions: {},
    serverPort: 3210,
    serverToken: null,
    modelSwitching: false,
    followupsBySession: {},
  } as never);
  useStore.getState().clearSession('/session/media.jsonl');
  useStore.getState().initSession('/session/media.jsonl', [], false);
}

function queueDraft(text: string) {
  return {
    text, editorJson: { type: 'doc', content: [] },
    skills: [], sessionRefs: [], agentMentions: [], attachedFiles: [], quotes: [],
    docContextAttached: false, doc: null,
  };
}

function focusQueueTestOnB(overrides: Record<string, unknown> = {}) {
  useStore.setState({
    currentSessionPath: '/session/b.jsonl', currentSessionId: 'sess_b', currentAgentId: 'agent-b',
    sessions: [
      { path: '/session/media.jsonl', sessionId: 'sess_media', agentId: 'hana', agentName: 'A' },
      { path: '/session/b.jsonl', sessionId: 'sess_b', agentId: 'agent-b', agentName: 'B' },
    ],
    sessionLocatorsById: { sess_media: { path: '/session/media.jsonl' }, sess_b: { path: '/session/b.jsonl' } },
    streamingSessions: ['sess_media'], compactingSessions: [], capabilityRefreshingSessions: [],
    pendingNewSession: false, pendingDraftId: null, pendingSessionSwitchPath: null, modelSwitching: false,
    attachedFiles: [], attachedFilesBySession: {},
    models: [
      { id: 'a-vision', provider: 'vision', input: ['text', 'image'] },
      { id: 'b-text', provider: 'text-only', input: ['text'], isCurrent: true },
    ],
    sessionModelsByPath: {
      sess_media: { id: 'a-vision', provider: 'vision', input: ['text', 'image'] },
      sess_b: { id: 'b-text', provider: 'text-only', input: ['text'] },
    },
    ...overrides,
  } as never);
}

function installAudioCaptureMocks() {
  type MockAudioProcessor = {
    onaudioprocess: ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  };
  let processor: MockAudioProcessor | null = null;
  const stopTrack = vi.fn();
  const stream = {
    getTracks: vi.fn(() => [{ stop: stopTrack }]),
  };
  class AudioContextMock {
    sampleRate = 24000;
    state = 'running';
    destination = {};
    createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
    createScriptProcessor = vi.fn(() => {
      processor = {
        onaudioprocess: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      return processor;
    });
    createGain = vi.fn(() => ({ gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() }));
    close = vi.fn(async () => {});
  }
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => stream) },
  });
  vi.stubGlobal('AudioContext', AudioContextMock);
  return {
    get processor() {
      return processor;
    },
    stopTrack,
  };
}

describe('InputArea media send', () => {
  afterEach(() => {
    cleanup();
    resetFollowupSendRuntimeForTest();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureSession.mockResolvedValue({
      sessionId: 'sess_media',
      sessionPath: '/session/media.jsonl',
      agentId: 'hana',
    });
    seedSession();
    mocks.hanaFetch.mockResolvedValue(new Response(JSON.stringify({
      models: {
        vision_enabled: true,
        vision: { id: 'qwen-vl', provider: 'dashscope', input: ['text', 'image'] },
      },
    }), { status: 200 }));
    window.platform = {
      readFileBase64: vi.fn(async () => 'IMAGE_BASE64'),
    } as unknown as typeof window.platform;
    delete (window as unknown as { hana?: unknown }).hana;
  });

  it.each(['stale', 'missing', 'unavailable'])('keeps BPS saved levels when the session snapshot is %s', (snapshot) => {
    const levels = ['low', 'medium', 'high', 'xhigh'];
    useStore.setState({
      models: [
        { id: 'gpt-6-astra', provider: 'openai-codex', thinkingLevels: [...levels, 'max'], input: ['text', 'image'] },
        { id: 'gpt-6-astra', provider: 'tokyo-bps', thinkingLevels: levels, input: ['text', 'image'], reasoning: true, isCurrent: true },
      ],
      sessionModelsByPath: { sess_media: {
        id: 'gpt-6-astra', provider: 'tokyo-bps',
        thinkingLevels: snapshot === 'missing' ? undefined : [...levels, 'max'],
        available: snapshot !== 'unavailable',
        unavailableReason: snapshot === 'unavailable' ? 'temporarily_unavailable' : null,
      } },
    } as never);
    render(React.createElement(InputArea));
    const send = screen.getByTestId('send') as HTMLButtonElement;
    expect(send.getAttribute('data-thinking-levels')).toBe(levels.join(','));
    if (snapshot === 'unavailable') expect(send.disabled).toBe(true);
  });

  it('sends path-backed images as file identity plus pixels so older servers can still see them', async () => {
    render(React.createElement(InputArea));

    fireEvent.click(screen.getByTestId('send'));

    await waitFor(() => {
      expect(mocks.wsSend).toHaveBeenCalledTimes(1);
    });
    expect(window.platform.readFileBase64).toHaveBeenCalledWith('/tmp/hana/session-files/pasted.png');
    const payload = JSON.parse(String(mocks.wsSend.mock.calls[0][0]));
    expect(payload.images).toEqual([
      { type: 'image', data: 'IMAGE_BASE64', mimeType: 'image/png' },
    ]);
    expect(payload.displayMessage.attachments[0]).toMatchObject({
      fileId: 'sf_pasted',
      path: '/tmp/hana/session-files/pasted.png',
      name: 'pasted.png',
      visionAuxiliary: true,
    });
    expect(mocks.hanaFetch).toHaveBeenCalledWith('/api/preferences/models', undefined);
  });

  it('keeps an async pending-session submission bound to its original session and leaves the new composer intact (#2078)', async () => {
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    mocks.ensureSession.mockImplementationOnce(async (draftId: string) => {
      expect(draftId).toBe('draft-a');
      await createGate;
      return { sessionId: 'sess_a', sessionPath: '/session/a.jsonl', agentId: 'hana' };
    });
    useStore.setState({
      currentSessionPath: null,
      currentSessionId: null,
      pendingNewSession: true,
      pendingDraftId: 'draft-a',
      attachedFiles: [{
        fileId: 'sf_a',
        path: '/tmp/hana/session-files/a.png',
        name: 'a.png',
        isDirectory: false,
      }],
      attachedFilesBySession: {},
      sessions: [],
    } as never);

    render(React.createElement(InputArea));
    fireEvent.click(screen.getByTestId('send'));
    await waitFor(() => expect(mocks.ensureSession).toHaveBeenCalledTimes(1));

    useStore.setState({
      currentSessionPath: '/session/b.jsonl',
      currentSessionId: 'sess_b',
      currentAgentId: 'hana',
      pendingNewSession: false,
      pendingDraftId: null,
      sessions: [{ path: '/session/b.jsonl', sessionId: 'sess_b', agentId: 'hana', agentName: 'Hana' }],
      sessionLocatorsById: { sess_b: { path: '/session/b.jsonl' } },
      attachedFiles: [{ fileId: 'sf_b', path: '/tmp/b.txt', name: 'b.txt', isDirectory: false }],
      attachedFilesBySession: {
        sess_b: [{ fileId: 'sf_b', path: '/tmp/b.txt', name: 'b.txt', isDirectory: false }],
      },
    } as never);
    releaseCreate();

    await waitFor(() => expect(mocks.wsSend).toHaveBeenCalledTimes(1));
    const payload = JSON.parse(String(mocks.wsSend.mock.calls[0][0]));
    expect(payload).toMatchObject({
      type: 'prompt',
      sessionId: 'sess_a',
      sessionPath: '/session/a.jsonl',
    });
    expect(payload.displayMessage.attachments).toEqual([
      expect.objectContaining({ fileId: 'sf_a', path: '/tmp/hana/session-files/a.png' }),
    ]);
    expect(useStore.getState().attachedFiles).toEqual([
      expect.objectContaining({ fileId: 'sf_b', path: '/tmp/b.txt' }),
    ]);
  });

  it('keeps the send alive as file-only when the text model has no auxiliary vision (#1647)', async () => {
    mocks.hanaFetch.mockResolvedValue(new Response(JSON.stringify({
      models: { vision_enabled: false, vision: null },
    }), { status: 200 }));

    render(React.createElement(InputArea));

    fireEvent.click(screen.getByTestId('send'));

    await waitFor(() => {
      expect(mocks.wsSend).toHaveBeenCalledTimes(1);
    });
    const payload = JSON.parse(String(mocks.wsSend.mock.calls[0][0]));
    // 不带像素载荷，但文件身份（fileId + path）保留，服务端会注册 SessionFile 并注入路径 marker
    expect(payload.images).toBeUndefined();
    expect(payload.displayMessage.attachments[0]).toMatchObject({
      fileId: 'sf_pasted',
      path: '/tmp/hana/session-files/pasted.png',
      name: 'pasted.png',
      visionAuxiliary: false,
    });
    // 不读图片字节
    expect(window.platform.readFileBase64).not.toHaveBeenCalled();
  });

  it('falls back to file identity when path-backed image bytes cannot be read', async () => {
    window.platform = {
      readFileBase64: vi.fn(async () => null),
    } as unknown as typeof window.platform;

    render(React.createElement(InputArea));

    fireEvent.click(screen.getByTestId('send'));

    await waitFor(() => {
      expect(mocks.wsSend).toHaveBeenCalledTimes(1);
    });
    expect(window.platform.readFileBase64).toHaveBeenCalledWith('/tmp/hana/session-files/pasted.png');
    const payload = JSON.parse(String(mocks.wsSend.mock.calls[0][0]));
    expect(payload.images).toBeUndefined();
    expect(payload.displayMessage.attachments[0]).toMatchObject({
      fileId: 'sf_pasted',
      path: '/tmp/hana/session-files/pasted.png',
      visionAuxiliary: false,
    });
  });

  it('uses the chat-scoped auxiliary vision route for mobile image preflight', async () => {
    mocks.hanaFetch.mockImplementation(async (path: string) => {
      if (path === '/api/models/auxiliary-vision') {
        return new Response(JSON.stringify({
          auxiliaryVision: {
            enabled: true,
            configured: true,
            available: true,
            unavailableReason: null,
            model: { id: 'qwen-vl', provider: 'dashscope' },
          },
        }), { status: 200 });
      }
      if (path === '/api/preferences/models') {
        throw new Error('mobile preflight must not read settings preferences');
      }
      throw new Error(`unexpected fetch path ${path}`);
    });

    render(<InputArea surface="mobile" />);

    fireEvent.click(screen.getByTestId('send'));

    await waitFor(() => {
      expect(mocks.wsSend).toHaveBeenCalledTimes(1);
    });
    expect(mocks.hanaFetch).toHaveBeenCalledWith('/api/models/auxiliary-vision', undefined);
    expect(mocks.hanaFetch.mock.calls.some(([path]) => path === '/api/preferences/models')).toBe(false);
  });

  it('sends audio bytes natively for official MiMo audio models', async () => {
    useStore.setState({
      attachedFiles: [{
        fileId: 'sf_voice',
        path: '/tmp/hana/session-files/voice.wav',
        name: 'voice.wav',
        isDirectory: false,
      }],
      attachedFilesBySession: {
        '/session/media.jsonl': [{
          fileId: 'sf_voice',
          path: '/tmp/hana/session-files/voice.wav',
          name: 'voice.wav',
          isDirectory: false,
        }],
      },
      models: [{
        id: 'mimo-v2.5',
        provider: 'mimo',
        name: 'MiMo V2.5',
        api: 'openai-completions',
        baseUrl: 'https://api.xiaomimimo.com/v1',
        input: ['text', 'audio'],
        isCurrent: true,
      }],
    } as never);
    window.platform = {
      readFileBase64: vi.fn(async () => 'AUDIO_BASE64'),
    } as unknown as typeof window.platform;

    render(React.createElement(InputArea));

    fireEvent.click(screen.getByTestId('send'));

    await waitFor(() => {
      expect(mocks.wsSend).toHaveBeenCalledTimes(1);
    });
    const payload = JSON.parse(String(mocks.wsSend.mock.calls[0][0]));
    expect(window.platform.readFileBase64).toHaveBeenCalledWith('/tmp/hana/session-files/voice.wav');
    expect(payload.text).toBe('');
    expect(payload.audios).toEqual([{
      type: 'audio',
      data: 'AUDIO_BASE64',
      mimeType: 'audio/wav',
    }]);
    expect(payload.displayMessage.attachments[0]).toMatchObject({
      fileId: 'sf_voice',
      path: '/tmp/hana/session-files/voice.wav',
      name: 'voice.wav',
      mimeType: 'audio/wav',
    });
  });

  it('uses the switched session model audio snapshot when sending recorded audio', async () => {
    useStore.setState({
      attachedFiles: [{
        fileId: 'sf_recording',
        path: '/tmp/hana/session-files/recording.wav',
        name: '录音 1.wav',
        isDirectory: false,
        mimeType: 'audio/wav',
      }],
      attachedFilesBySession: {
        '/session/media.jsonl': [{
          fileId: 'sf_recording',
          path: '/tmp/hana/session-files/recording.wav',
          name: '录音 1.wav',
          isDirectory: false,
          mimeType: 'audio/wav',
        }],
      },
      models: [{
        id: 'deepseek-chat',
        provider: 'deepseek',
        name: 'DeepSeek Chat',
        input: ['text'],
        isCurrent: true,
      }],
      sessionModelsByPath: {
        '/session/media.jsonl': {
          id: 'mimo-v2.5',
          provider: 'mimo',
          name: 'MiMo V2.5',
          input: ['text'],
          audio: true,
          audioTransport: 'mimo-input-audio',
          audioTransportSupported: true,
        },
      },
    } as never);
    window.platform = {
      readFileBase64: vi.fn(async () => 'AUDIO_BASE64'),
    } as unknown as typeof window.platform;

    render(React.createElement(InputArea));

    fireEvent.click(screen.getByTestId('send'));

    await waitFor(() => {
      expect(mocks.wsSend).toHaveBeenCalledTimes(1);
    });
    const payload = JSON.parse(String(mocks.wsSend.mock.calls[0][0]));
    expect(window.platform.readFileBase64).toHaveBeenCalledWith('/tmp/hana/session-files/recording.wav');
    expect(payload.text).toBe('');
    expect(payload.audios).toEqual([{
      type: 'audio',
      data: 'AUDIO_BASE64',
      mimeType: 'audio/wav',
    }]);
    expect(payload.displayMessage.attachments[0]).toMatchObject({
      fileId: 'sf_recording',
      path: '/tmp/hana/session-files/recording.wav',
      name: '录音 1.wav',
      mimeType: 'audio/wav',
    });
  });

  it('sends recorded audio immediately after saving the recording', async () => {
    const audioMocks = installAudioCaptureMocks();
    mocks.hanaFetch.mockImplementation(async (path: string) => {
      if (path === '/api/upload-blob') {
        return new Response(JSON.stringify({
          uploads: [{
            fileId: 'sf_recording',
            dest: '/tmp/hana/session-files/recording.wav',
            name: '录音 1.wav',
            presentation: 'voice-input',
            listed: false,
          }],
        }), { status: 200 });
      }
      throw new Error(`unexpected fetch path ${path}`);
    });
    useStore.setState({
      attachedFiles: [],
      attachedFilesBySession: { '/session/media.jsonl': [] },
      models: [{
        id: 'mimo-v2.5',
        provider: 'mimo',
        name: 'MiMo V2.5',
        api: 'openai-completions',
        baseUrl: 'https://api.xiaomimimo.com/v1',
        audio: true,
        audioTransport: 'mimo-input-audio',
        audioTransportSupported: true,
        input: ['text'],
        isCurrent: true,
      }],
    } as never);

    render(React.createElement(InputArea));

    fireEvent.click(screen.getByTestId('record-audio'));

    await waitFor(() => {
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
      expect(audioMocks.processor).not.toBeNull();
      expect(screen.getByTestId('record-audio').textContent).toBe('stop');
    });
    const activeProcessor = audioMocks.processor!;
    activeProcessor.onaudioprocess?.({
      inputBuffer: {
        getChannelData: () => new Float32Array([0.12, -0.12, 0.08, -0.08]),
      },
    });

    fireEvent.click(screen.getByTestId('record-audio'));

    await waitFor(() => {
      expect(mocks.hanaFetch).toHaveBeenCalledWith('/api/upload-blob', expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"presentation":"voice-input"'),
      }));
      expect(mocks.wsSend).toHaveBeenCalledTimes(1);
    });
    const uploadBody = JSON.parse(String(mocks.hanaFetch.mock.calls[0][1]?.body));
    expect(uploadBody.waveform).toMatchObject({
      version: 1,
      durationMs: expect.any(Number),
      source: 'computed',
    });
    expect(uploadBody.waveform.peaks.length).toBeGreaterThan(0);
    const payload = JSON.parse(String(mocks.wsSend.mock.calls[0][0]));
    expect(payload.text).toBe('');
    expect(payload.audios).toEqual([{
      type: 'audio',
      data: expect.any(String),
      mimeType: 'audio/wav',
    }]);
    expect(payload.displayMessage).toMatchObject({
      text: '',
      attachments: [{
        fileId: 'sf_recording',
        path: '/tmp/hana/session-files/recording.wav',
        name: '录音 1.wav',
        isDir: false,
        mimeType: 'audio/wav',
        presentation: 'voice-input',
        listed: false,
        waveform: expect.objectContaining({
          version: 1,
          peaks: expect.any(Array),
          source: 'computed',
        }),
      }],
    });
    expect(useStore.getState().attachedFiles).toEqual([]);
    expect(audioMocks.stopTrack).toHaveBeenCalled();
  });

  it('starts recording from the app-local voice shortcut only on the focused chat page', async () => {
    installAudioCaptureMocks();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useStore.setState({
      attachedFiles: [],
      currentTab: 'chat',
      settingsModal: { open: false, activeTab: 'agent' },
      mediaViewer: null,
      skillViewerData: null,
      channelCreateOverlayVisible: false,
      models: [{
        id: 'mimo-v2.5',
        provider: 'mimo',
        name: 'MiMo V2.5',
        api: 'openai-completions',
        baseUrl: 'https://api.xiaomimimo.com/v1',
        audio: true,
        audioTransport: 'mimo-input-audio',
        audioTransportSupported: true,
        input: ['text'],
        isCurrent: true,
      }],
    } as never);

    render(React.createElement(InputArea));

    fireEvent.keyDown(window, { key: 'm', ctrlKey: true, shiftKey: true });

    await waitFor(() => {
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    });
  });

  it('ignores the app-local voice shortcut while settings is open', () => {
    installAudioCaptureMocks();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useStore.setState({
      attachedFiles: [],
      currentTab: 'chat',
      settingsModal: { open: true, activeTab: 'agent' },
      mediaViewer: null,
      skillViewerData: null,
      channelCreateOverlayVisible: false,
      models: [{
        id: 'mimo-v2.5',
        provider: 'mimo',
        name: 'MiMo V2.5',
        api: 'openai-completions',
        baseUrl: 'https://api.xiaomimimo.com/v1',
        audio: true,
        audioTransport: 'mimo-input-audio',
        audioTransportSupported: true,
        input: ['text'],
        isCurrent: true,
      }],
    } as never);

    render(React.createElement(InputArea));

    fireEvent.keyDown(window, { key: 'm', ctrlKey: true, shiftKey: true });

    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('keeps audio attachments on the legacy text path for unsupported models', async () => {
    useStore.setState({
      attachedFiles: [{
        fileId: 'sf_voice',
        path: '/tmp/hana/session-files/voice.wav',
        name: 'voice.wav',
        isDirectory: false,
      }],
      attachedFilesBySession: {
        '/session/media.jsonl': [{
          fileId: 'sf_voice',
          path: '/tmp/hana/session-files/voice.wav',
          name: 'voice.wav',
          isDirectory: false,
        }],
      },
    } as never);

    render(React.createElement(InputArea));

    fireEvent.click(screen.getByTestId('send'));

    await waitFor(() => {
      expect(mocks.wsSend).toHaveBeenCalledTimes(1);
    });
    const payload = JSON.parse(String(mocks.wsSend.mock.calls[0][0]));
    expect(payload.audios).toBeUndefined();
    expect(payload.text).toBe('[附件] voice.wav');
    expect(payload.sessionFileRefs).toEqual([{
      fileId: 'sf_voice',
      sessionId: 'sess_media',
      sessionPath: '/session/media.jsonl',
      label: 'voice.wav',
      kind: 'attachment',
    }]);
    expect(window.platform.readFileBase64).not.toHaveBeenCalled();
  });

  it('keeps video attachments on the file-only path for unsupported models', async () => {
    useStore.setState({
      attachedFiles: [{
        fileId: 'sf_clip',
        path: '/tmp/hana/session-files/clip.mp4',
        name: 'clip.mp4',
        mimeType: 'video/mp4',
        isDirectory: false,
      }],
      attachedFilesBySession: {
        '/session/media.jsonl': [{
          fileId: 'sf_clip',
          path: '/tmp/hana/session-files/clip.mp4',
          name: 'clip.mp4',
          mimeType: 'video/mp4',
          isDirectory: false,
        }],
      },
    } as never);

    render(React.createElement(InputArea));

    fireEvent.click(screen.getByTestId('send'));

    await waitFor(() => {
      expect(mocks.wsSend).toHaveBeenCalledTimes(1);
    });
    const payload = JSON.parse(String(mocks.wsSend.mock.calls[0][0]));
    expect(payload.videos).toBeUndefined();
    expect(payload.text).toBe('[附件] clip.mp4');
    expect(payload.sessionFileRefs).toEqual([{
      fileId: 'sf_clip',
      sessionId: 'sess_media',
      sessionPath: '/session/media.jsonl',
      label: 'clip.mp4',
      kind: 'attachment',
    }]);
    expect(payload.displayMessage.attachments[0]).toMatchObject({
      fileId: 'sf_clip',
      path: '/tmp/hana/session-files/clip.mp4',
      name: 'clip.mp4',
      mimeType: 'video/mp4',
    });
    expect(window.platform.readFileBase64).not.toHaveBeenCalled();
  });

  it('sends ordinary attachments by fileId instead of using visible path text as the machine contract', async () => {
    useStore.setState({
      attachedFiles: [{
        fileId: 'sf_cjk_digits',
        path: '/Users/testuser/Desktop/测试123/报告2026.txt',
        name: '报告2026.txt',
        isDirectory: false,
      }],
      attachedFilesBySession: {
        '/session/media.jsonl': [{
          fileId: 'sf_cjk_digits',
          path: '/Users/testuser/Desktop/测试123/报告2026.txt',
          name: '报告2026.txt',
          isDirectory: false,
        }],
      },
    } as never);

    render(React.createElement(InputArea));

    fireEvent.click(screen.getByTestId('send'));

    await waitFor(() => {
      expect(mocks.wsSend).toHaveBeenCalledTimes(1);
    });
    const payload = JSON.parse(String(mocks.wsSend.mock.calls[0][0]));
    expect(payload.text).toBe('[附件] 报告2026.txt');
    expect(payload.text).not.toContain('/Users/testuser/Desktop/测试123');
    expect(payload.sessionFileRefs).toEqual([{
      fileId: 'sf_cjk_digits',
      sessionId: 'sess_media',
      sessionPath: '/session/media.jsonl',
      label: '报告2026.txt',
      kind: 'attachment',
    }]);
    expect(payload.displayMessage.attachments[0]).toMatchObject({
      fileId: 'sf_cjk_digits',
      path: '/Users/testuser/Desktop/测试123/报告2026.txt',
      name: '报告2026.txt',
    });
  });

  it('queues streaming attachment sends instead of steering immediately', async () => {
    useStore.setState({
      streamingSessions: ['/session/media.jsonl'],
      attachedFiles: [{
        fileId: 'sf_note',
        path: '/Users/testuser/Desktop/note.txt',
        name: 'note.txt',
        isDirectory: false,
      }],
      attachedFilesBySession: {
        '/session/media.jsonl': [{
          fileId: 'sf_note',
          path: '/Users/testuser/Desktop/note.txt',
          name: 'note.txt',
          isDirectory: false,
        }],
      },
    } as never);

    render(React.createElement(InputArea));

    const send = screen.getByTestId('send') as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);

    await waitFor(() => {
      expect(useStore.getState().followupsBySession['sess_media'] || useStore.getState().followupsBySession['/session/media.jsonl']).toHaveLength(1);
    });
    expect(mocks.wsSend).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('插话'));

    await waitFor(() => {
      expect(mocks.wsSend).toHaveBeenCalledTimes(1);
    });
    const payload = JSON.parse(String(mocks.wsSend.mock.calls[0][0]));
    expect(payload.type).toBe('interject');
    expect(payload.text).toBe('[附件] note.txt');
    expect(payload.sessionFileRefs).toEqual([{
      fileId: 'sf_note',
      sessionId: 'sess_media',
      sessionPath: '/session/media.jsonl',
      label: 'note.txt',
      kind: 'attachment',
    }]);
    expect(payload.displayMessage).toMatchObject({
      text: '',
      attachments: [{
        fileId: 'sf_note',
        path: '/Users/testuser/Desktop/note.txt',
        name: 'note.txt',
      }],
    });
  });

  it('keeps the send reservation across an InputArea remount while reading an attachment', async () => {
    let release!: () => void;
    const reading = new Promise<void>(resolve => { release = resolve; });
    window.platform.readFileBase64 = vi.fn(async () => { await reading; return 'IMAGE_BASE64'; });
    useStore.setState({ streamingSessions: ['sess_media'], attachedFiles: [], attachedFilesBySession: {} } as never);
    const first = render(React.createElement(InputArea));
    useStore.getState().enqueueFollowup('/session/media.jsonl', {
      ...queueDraft('one reserved message'),
      attachedFiles: [{fileId:'sf_reserved',path:'/tmp/reserved.png',name:'reserved.png',isDirectory:false}],
    });
    useStore.setState({ streamingSessions: [] } as never);
    await waitFor(() => expect(window.platform.readFileBase64).toHaveBeenCalledTimes(1));
    first.unmount();
    render(React.createElement(InputArea));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(window.platform.readFileBase64).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => expect(mocks.wsSend).toHaveBeenCalledTimes(1));
    expect(useStore.getState().peekFollowup('/session/media.jsonl')).toBeNull();
  });

  it('sends a background queue to its owner rather than the focused session', async () => {
    const bFile = { fileId: 'sf_b', path: '/tmp/b.txt', name: 'b.txt', isDirectory: false };
    useStore.setState({
      currentSessionPath: '/session/b.jsonl',
      currentSessionId: 'sess_b',
      currentAgentId: 'agent-b',
      sessions: [
        ...useStore.getState().sessions,
        { path: '/session/b.jsonl', sessionId: 'sess_b', agentId: 'agent-b', agentName: 'B' },
      ],
      sessionLocatorsById: {
        sess_media: { path: '/session/media.jsonl' },
        sess_b: { path: '/session/b.jsonl' },
      },
      streamingSessions: ['sess_media'],
      compactingSessions: [],
      capabilityRefreshingSessions: [],
      attachedFiles: [bFile],
      attachedFilesBySession: { sess_b: [bFile] },
      drafts: { '/session/b.jsonl': 'B draft must remain untouched' },
    } as never);
    render(React.createElement(InputArea));
    useStore.getState().enqueueFollowup('/session/media.jsonl', {
      text: 'A queued request',
      editorJson: { type: 'doc', content: [] },
      skills: [], sessionRefs: [], agentMentions: [], quotes: [],
      attachedFiles: [{ fileId: 'sf_a', path: '/tmp/a.txt', name: 'a.txt', isDirectory: false }],
      docContextAttached: false, doc: null,
    });
    useStore.setState({ streamingSessions: [] } as never);

    await waitFor(() => expect(mocks.wsSend).toHaveBeenCalledTimes(1));
    const payload = JSON.parse(String(mocks.wsSend.mock.calls[0][0]));
    expect(payload).toMatchObject({ type: 'prompt', sessionId: 'sess_media', sessionPath: '/session/media.jsonl' });
    expect(payload.sessionFileRefs[0]).toMatchObject({ fileId: 'sf_a', sessionId: 'sess_media', sessionPath: '/session/media.jsonl' });
    expect(useStore.getState().currentSessionId).toBe('sess_b');
    expect(useStore.getState().attachedFiles).toEqual([bFile]);
    expect(useStore.getState().drafts['/session/b.jsonl']).toBe('B draft must remain untouched');
    await waitFor(() => expect(useStore.getState().peekFollowup('/session/media.jsonl')).toBeNull());
  });

  it.each(['streaming', 'compacting', 'refreshing', 'unavailable', 'deleted'])(
    'does not let focused B being %s block the background A queue', async (blocked) => {
      focusQueueTestOnB();
      if (blocked === 'streaming') useStore.setState({ streamingSessions: ['sess_media', 'sess_b'] } as never);
      if (blocked === 'compacting') useStore.setState({ compactingSessions: ['sess_b'] } as never);
      if (blocked === 'refreshing') useStore.setState({ capabilityRefreshingSessions: ['sess_b'] } as never);
      if (blocked === 'unavailable') useStore.setState({ sessionModelsByPath: { sess_b: { id: 'b-text', provider: 'text-only', available: false } } } as never);
      if (blocked === 'deleted') useStore.setState({ sessions: useStore.getState().sessions.map(s => s.sessionId === 'sess_b' ? { ...s, agentDeleted: true } : s) } as never);
      render(React.createElement(InputArea));
      useStore.getState().enqueueFollowup('/session/media.jsonl', queueDraft('Only A'));
      useStore.setState({ streamingSessions: blocked === 'streaming' ? ['sess_b'] : [] } as never);
      await waitFor(() => expect(mocks.wsSend).toHaveBeenCalledTimes(1));
      expect(JSON.parse(String(mocks.wsSend.mock.calls[0][0]))).toMatchObject({ sessionId: 'sess_media', sessionPath: '/session/media.jsonl' });
    },
  );

  it('resumes background A after compaction while B remains focused', async () => {
    focusQueueTestOnB({ streamingSessions: [], compactingSessions: ['sess_media'] });
    render(React.createElement(InputArea));
    useStore.getState().enqueueFollowup('/session/media.jsonl', queueDraft('After A compaction'));
    expect(mocks.wsSend).not.toHaveBeenCalled();
    useStore.setState({ compactingSessions: [] } as never);
    await waitFor(() => expect(mocks.wsSend).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(mocks.wsSend.mock.calls[0][0])).sessionId).toBe('sess_media');
  });

  it('keeps A identity and native image capability while focus changes during image reading', async () => {
    focusQueueTestOnB();
    let release!: (value: string) => void;
    const gate = new Promise<string>(resolve => { release = resolve; });
    window.platform.readFileBase64 = vi.fn(() => gate);
    render(React.createElement(InputArea));
    useStore.getState().enqueueFollowup('/session/media.jsonl', {
      ...queueDraft('A image'),
      attachedFiles: [{ fileId: 'sf_a_image', path: '/tmp/a.png', name: 'a.png', isDirectory: false }],
    });
    useStore.setState({ streamingSessions: [] } as never);
    await waitFor(() => expect(window.platform.readFileBase64).toHaveBeenCalledWith('/tmp/a.png'));
    useStore.setState({ currentSessionPath: null, currentSessionId: null, pendingNewSession: true, pendingDraftId: 'draft-c' } as never);
    release('A_PIXELS');
    await waitFor(() => expect(mocks.wsSend).toHaveBeenCalledTimes(1));
    const payload = JSON.parse(String(mocks.wsSend.mock.calls[0][0]));
    expect(payload).toMatchObject({ sessionId: 'sess_media', sessionPath: '/session/media.jsonl', uiContext: null });
    expect(payload.images).toEqual([{ type: 'image', data: 'A_PIXELS', mimeType: 'image/png' }]);
    expect(payload.displayMessage.attachments[0].visionAuxiliary).toBe(false);
    expect(mocks.ensureSession).not.toHaveBeenCalled();
  });

  it('keeps an unresolved background owner queued instead of sending to B', async () => {
    focusQueueTestOnB({ streamingSessions: [] });
    render(React.createElement(InputArea));
    useStore.getState().enqueueFollowup('sess_unknown', queueDraft('Unknown owner'));
    await new Promise(resolve => window.setTimeout(resolve, 40));
    expect(mocks.wsSend).not.toHaveBeenCalled();
    expect(useStore.getState().peekFollowup('sess_unknown')?.text).toBe('Unknown owner');
  });

  it('removes only A entry even if busy B has an entry with the same id', async () => {
    focusQueueTestOnB({ streamingSessions: ['sess_media', 'sess_b'] });
    render(React.createElement(InputArea));
    useStore.getState().enqueueFollowup('/session/media.jsonl', { ...queueDraft('A one'), id: 'shared-item-id' });
    useStore.getState().enqueueFollowup('/session/b.jsonl', { ...queueDraft('B untouched'), id: 'shared-item-id' });
    useStore.setState({ streamingSessions: ['sess_b'] } as never);
    await waitFor(() => expect(mocks.wsSend).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useStore.getState().peekFollowup('/session/media.jsonl')).toBeNull());
    expect(useStore.getState().peekFollowup('/session/b.jsonl')?.text).toBe('B untouched');
  });

  it('sends the queued followup as a prompt when compaction ends', async () => {
    useStore.setState({
      streamingSessions: [],
      compactingSessions: ['sess_media'],
      attachedFiles: [],
      attachedFilesBySession: { '/session/media.jsonl': [] },
    } as never);

    render(React.createElement(InputArea));
    useStore.getState().enqueueFollowup('/session/media.jsonl', {
      text: '套餐选许昌校区融合套餐',
      editorJson: { type: 'doc', content: [] },
      skills: [],
      sessionRefs: [],
      agentMentions: [],
      attachedFiles: [],
      quotes: [],
      docContextAttached: false,
      doc: null,
    });
    expect(mocks.wsSend).not.toHaveBeenCalled();

    useStore.setState({ compactingSessions: [] } as never);

    await waitFor(() => {
      expect(mocks.wsSend).toHaveBeenCalled();
    });
    const payload = JSON.parse(String(mocks.wsSend.mock.calls[0][0]));
    expect(payload.type).toBe('prompt');
    expect(payload.text).toBe('套餐选许昌校区融合套餐');
  });

  it('flushes queued followups one turn at a time', async () => {
    useStore.setState({
      streamingSessions: ['sess_media'],
      attachedFiles: [],
      attachedFilesBySession: { '/session/media.jsonl': [] },
    } as never);

    render(React.createElement(InputArea));
    const draft = (text: string) => ({
      text,
      editorJson: { type: 'doc', content: [] },
      skills: [],
      sessionRefs: [],
      agentMentions: [],
      attachedFiles: [],
      quotes: [],
      docContextAttached: false,
      doc: null,
    });
    useStore.getState().enqueueFollowup('/session/media.jsonl', draft('剩的都40%'));
    useStore.getState().enqueueFollowup('/session/media.jsonl', draft('加上一次性固定支出'));
    expect(mocks.wsSend).not.toHaveBeenCalled();

    useStore.setState({ streamingSessions: [] } as never);

    await waitFor(() => {
      expect(mocks.wsSend).toHaveBeenCalledTimes(1);
    });
    expect(JSON.parse(String(mocks.wsSend.mock.calls[0][0])).text).toBe('剩的都40%');
    await waitFor(() => {
      const queues = useStore.getState().followupsBySession;
      expect(queues.sess_media || queues['/session/media.jsonl'] || []).toHaveLength(1);
    });

    await new Promise((resolve) => { window.setTimeout(resolve, 40); });
    expect(mocks.wsSend).toHaveBeenCalledTimes(1);

    useStore.setState({ streamingSessions: ['sess_media'] } as never);
    useStore.setState({ streamingSessions: [] } as never);

    await waitFor(() => {
      expect(mocks.wsSend).toHaveBeenCalledTimes(2);
    });
    expect(JSON.parse(String(mocks.wsSend.mock.calls[1][0])).text).toBe('加上一次性固定支出');
  });

  it('sends the queued followup as a prompt when streaming ends', async () => {
    useStore.setState({
      streamingSessions: ['sess_media'],
      attachedFiles: [],
      attachedFilesBySession: { '/session/media.jsonl': [] },
    } as never);

    render(React.createElement(InputArea));
    useStore.getState().enqueueFollowup('/session/media.jsonl', {
      text: '接替跑学习通的测验',
      editorJson: { type: 'doc', content: [] },
      skills: [],
      sessionRefs: [],
      agentMentions: [],
      attachedFiles: [],
      quotes: [],
      docContextAttached: false,
      doc: null,
    });
    expect(mocks.wsSend).not.toHaveBeenCalled();

    useStore.setState({ streamingSessions: [] } as never);

    await waitFor(() => {
      expect(mocks.wsSend).toHaveBeenCalled();
    });
    const payload = JSON.parse(String(mocks.wsSend.mock.calls[0][0]));
    expect(payload.type).toBe('prompt');
    expect(payload.text).toBe('接替跑学习通的测验');
    await waitFor(() => {
      const queues = useStore.getState().followupsBySession;
      expect(queues.sess_media || queues['/session/media.jsonl'] || []).toHaveLength(0);
    });
  });

  it.each(['remove', 'clear', 'edit'] as const)('does not send a queued attachment read after %s', async (action) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    window.platform.readFileBase64 = vi.fn(async () => { await gate; return 'IMAGE_BASE64'; });
    useStore.setState({ attachedFiles: [], attachedFilesBySession: {}, streamingSessions: ['sess_media'] } as never);
    render(React.createElement(InputArea));
    useStore.getState().enqueueFollowup('/session/media.jsonl', {
      ...queueDraft('cancelled request'),
      attachedFiles: [{ fileId: 'sf_audit', path: '/tmp/audit.png', name: 'audit.png', isDirectory: false }],
    });
    useStore.setState({ streamingSessions: [] } as never);
    await waitFor(() => expect(window.platform.readFileBase64).toHaveBeenCalledTimes(1));
    if (action === 'clear') fireEvent.click(screen.getByRole('button', { name: '清空排队' }));
    else if (action === 'edit') fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    else fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(useStore.getState().peekFollowup('/session/media.jsonl')).toBeNull();
    release();
    await new Promise((resolve) => { window.setTimeout(resolve, 30); });
    expect(mocks.wsSend).not.toHaveBeenCalled();
  });

  it('shares one reservation between automatic flush and the queue send button', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    window.platform.readFileBase64 = vi.fn(async () => { await gate; return 'IMAGE_BASE64'; });
    useStore.setState({ attachedFiles: [], attachedFilesBySession: {}, streamingSessions: ['sess_media'] } as never);
    render(React.createElement(InputArea));
    useStore.getState().enqueueFollowup('/session/media.jsonl', {
      ...queueDraft('duplicate request'),
      attachedFiles: [{ fileId: 'sf_audit', path: '/tmp/audit.png', name: 'audit.png', isDirectory: false }],
    });
    useStore.setState({ streamingSessions: [] } as never);
    await waitFor(() => expect(window.platform.readFileBase64).toHaveBeenCalledTimes(1));
    const queueSend = screen.getAllByRole('button', { name: '发送' }).find((el) => el.dataset.testid !== 'send');
    expect(queueSend).toBeTruthy();
    fireEvent.click(queueSend!);
    release();
    await waitFor(() => expect(mocks.wsSend).toHaveBeenCalledTimes(1));
    expect(window.platform.readFileBase64).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(mocks.wsSend.mock.calls[0][0])).text).toContain('duplicate request');
    await waitFor(() => expect(useStore.getState().peekFollowup('/session/media.jsonl')).toBeNull());
  });

  it('keeps the queued item when submission becomes busy or the socket send fails', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    window.platform.readFileBase64 = vi.fn(async () => { await gate; return 'IMAGE_BASE64'; });
    useStore.setState({ attachedFiles: [], attachedFilesBySession: {}, streamingSessions: ['sess_media'] } as never);
    render(React.createElement(InputArea));
    useStore.getState().enqueueFollowup('/session/media.jsonl', {
      ...queueDraft('keep me'),
      attachedFiles: [{ fileId: 'sf_audit', path: '/tmp/audit.png', name: 'audit.png', isDirectory: false }],
    });
    useStore.setState({ streamingSessions: [] } as never);
    await waitFor(() => expect(window.platform.readFileBase64).toHaveBeenCalledTimes(1));
    useStore.setState({ streamingSessions: ['sess_media'] } as never);
    release();
    await new Promise((resolve) => { window.setTimeout(resolve, 30); });
    expect(mocks.wsSend).not.toHaveBeenCalled();
    expect(useStore.getState().peekFollowup('/session/media.jsonl')?.text).toBe('keep me');

    mocks.wsSend.mockImplementationOnce(() => { throw new Error('socket down'); });
    useStore.setState({ streamingSessions: [] } as never);
    await waitFor(() => expect(mocks.wsSend).toHaveBeenCalledTimes(1));
    expect(useStore.getState().peekFollowup('/session/media.jsonl')?.text).toBe('keep me');

    mocks.wsSend.mockImplementation(() => undefined);
    useStore.setState({ streamingSessions: ['sess_media'] } as never);
    useStore.setState({ streamingSessions: [] } as never);
    await waitFor(() => expect(mocks.wsSend).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(useStore.getState().peekFollowup('/session/media.jsonl')).toBeNull());
  });

  it('does not send while an agent switch session is still pending', async () => {
    useStore.setState({ pendingSessionSwitchPath: '/session/new-agent.jsonl' } as never);

    render(React.createElement(InputArea));

    const send = screen.getByTestId('send') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(send);

    await waitFor(() => {
      expect(mocks.wsSend).not.toHaveBeenCalled();
    });
  });

  it('binds Stop to the focused session current stream identity (#2078)', async () => {
    useStore.setState({
      streamingSessions: ['sess_media'],
      activeSessionStreams: {
        sess_media: { streamId: 'stream-current', turnId: 'turn-current' },
      },
    } as never);

    render(React.createElement(InputArea));
    fireEvent.click(screen.getByTestId('stop'));

    expect(mocks.wsSend).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(mocks.wsSend.mock.calls[0][0]))).toEqual({
      type: 'abort',
      sessionId: 'sess_media',
      sessionPath: '/session/media.jsonl',
      streamId: 'stream-current',
    });
  });
});
