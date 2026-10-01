// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttachedFilesBar } from '../../components/input/AttachedFilesBar';
import { useStore } from '../../stores';
import { installWindowTestT } from '../helpers/i18n-test-strings';

const openAttachmentFile = vi.hoisted(() => vi.fn());
vi.mock('../../utils/file-preview', () => ({
  openAttachmentFile: (...args: unknown[]) => openAttachmentFile(...args),
}));

describe('AttachedFilesBar media chips', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    delete (window as unknown as { platform?: unknown }).platform;
    useStore.getState().closeMediaViewer();
    delete (window as unknown as { t?: unknown }).t;
    openAttachmentFile.mockReset();
  });

  it('renders image attachments with rounded thumbnail previews', () => {
    const onRemove = vi.fn();
    window.platform = {
      getFileUrl: vi.fn((path: string) => `file://${path}`),
    } as unknown as typeof window.platform;

    const { container } = render(<AttachedFilesBar
      files={[{ path: '/tmp/pasted.png', name: 'pasted.png', mimeType: 'image/png' }]}
      onRemove={onRemove}
    />);

    expect(screen.getByText('pasted.png')).toBeInTheDocument();
    const image = container.querySelector('img');
    expect(image).toHaveAttribute('src', 'file:///tmp/pasted.png');
    expect(window.platform.getFileUrl).toHaveBeenCalledWith('/tmp/pasted.png');

    fireEvent.click(screen.getByLabelText('Remove pasted.png'));
    expect(onRemove).toHaveBeenCalledWith(0);
  });

  it('opens the media viewer when an image chip is clicked', () => {
    installWindowTestT();
    const onRemove = vi.fn();
    window.platform = {
      getFileUrl: vi.fn((path: string) => `file://${path}`),
    } as unknown as typeof window.platform;

    render(<AttachedFilesBar
      files={[
        { path: '/tmp/a.png', name: 'a.png', mimeType: 'image/png' },
        { path: '/tmp/b.png', name: 'b.png', mimeType: 'image/png' },
      ]}
      onRemove={onRemove}
    />);

    fireEvent.click(screen.getByLabelText('预览 b.png'));

    const mv = useStore.getState().mediaViewer;
    expect(mv).toBeTruthy();
    expect(mv!.files.map(f => f.name)).toEqual(['a.png', 'b.png']);
    expect(mv!.currentId).toBe('input-att:1:/tmp/b.png');
    expect(onRemove).not.toHaveBeenCalled();
  });

  it('opens a document chip in the preview or the system viewer', () => {
    installWindowTestT();
    render(<AttachedFilesBar
      files={[{ path: '/tmp/cluster.docx', name: '课题组GPU集群-普通.docx' }]}
      onRemove={vi.fn()}
    />);

    fireEvent.click(screen.getByRole('button', { name: '预览 课题组GPU集群-普通.docx' }));
    expect(openAttachmentFile).toHaveBeenCalledWith('/tmp/cluster.docx', '课题组GPU集群-普通.docx');
  });

  it('renders audio attachments with a play control, fake waveform, and remove action', () => {
    const onRemove = vi.fn();
    const audioInstances: Array<{ src: string; play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> }> = [];
    const AudioMock = vi.fn().mockImplementation(function MockAudio(this: {
      src: string;
      play: ReturnType<typeof vi.fn>;
      pause: ReturnType<typeof vi.fn>;
      onended: (() => void) | null;
      onerror: (() => void) | null;
    }, src: string) {
      this.src = src;
      this.play = vi.fn(() => Promise.resolve());
      this.pause = vi.fn();
      this.onended = null;
      this.onerror = null;
      audioInstances.push(this);
    });
    vi.stubGlobal('Audio', AudioMock);
    window.platform = {
      getFileUrl: vi.fn((path: string) => `file://${path}`),
    } as unknown as typeof window.platform;

    const { container } = render(<AttachedFilesBar
      files={[{ path: '/tmp/clip.wav', name: 'clip.wav', mimeType: 'audio/wav' }]}
      onRemove={onRemove}
    />);

    expect(screen.getByTestId('audio-attachment-wave')).toBeInTheDocument();
    expect(screen.getByText('clip.wav')).toBeInTheDocument();
    expect(screen.getByLabelText('Play clip.wav')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Play clip.wav'));

    expect(AudioMock).toHaveBeenCalledWith('file:///tmp/clip.wav');
    expect(audioInstances[0].play).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText('Remove clip.wav'));

    expect(audioInstances[0].pause).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith(0);
  });
});
