import { describe, expect, it } from 'vitest';
import { mergeUnpersistedOptimisticIntoSend } from '../../utils/optimistic-user-send';

describe('mergeUnpersistedOptimisticIntoSend', () => {
  it('prepends stuck text and attachments that the next prompt does not already contain', () => {
    const merged = mergeUnpersistedOptimisticIntoSend({
      text: '继续',
      files: [],
      leftover: [{
        id: 'client-stuck',
        role: 'user',
        text: '封面写成科研Agent进度汇报',
        attachments: [{ path: '/tmp/cover.png', name: 'cover.png', isDir: false, mimeType: 'image/png' }],
      }],
    });

    expect(merged).toEqual({
      text: '封面写成科研Agent进度汇报\n\n继续',
      files: [{
        fileId: undefined,
        path: '/tmp/cover.png',
        name: 'cover.png',
        isDirectory: false,
        mimeType: 'image/png',
        base64Data: undefined,
        waveform: undefined,
      }],
      consumedIds: ['client-stuck'],
    });
  });

  it('does not duplicate text or attachments already in the new send', () => {
    const merged = mergeUnpersistedOptimisticIntoSend({
      text: '封面写成科研Agent进度汇报\n\n继续',
      files: [{ path: '/tmp/cover.png', name: 'cover.png' }],
      leftover: [{
        id: 'client-stuck',
        role: 'user',
        text: '封面写成科研Agent进度汇报',
        attachments: [{ path: '/tmp/cover.png', name: 'cover.png', isDir: false }],
      }],
    });

    expect(merged.text).toBe('封面写成科研Agent进度汇报\n\n继续');
    expect(merged.files).toEqual([{ path: '/tmp/cover.png', name: 'cover.png' }]);
    expect(merged.consumedIds).toEqual(['client-stuck']);
  });
});
