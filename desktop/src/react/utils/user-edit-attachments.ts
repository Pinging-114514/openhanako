import { hanaFetch } from '../hooks/use-hana-fetch';
import type { UserAttachment } from '../stores/chat-types';
import type { AttachedFile } from '../stores/input-slice';
import { prepareChatImageUpload } from './chat-image-upload-compression';

export function userAttachmentsToAttachedFiles(attachments?: UserAttachment[] | null): AttachedFile[] {
  return (attachments || []).map((attachment) => ({
    fileId: attachment.fileId,
    path: attachment.path,
    name: attachment.name,
    isDirectory: !!attachment.isDir,
    mimeType: attachment.mimeType,
    base64Data: attachment.base64Data,
    waveform: attachment.waveform,
  }));
}

export function attachedFilesToUserAttachments(files: AttachedFile[]): UserAttachment[] {
  return files.map((file) => ({
    fileId: file.fileId,
    path: file.path,
    name: file.name,
    isDir: !!file.isDirectory,
    mimeType: file.mimeType,
    base64Data: file.base64Data,
    waveform: file.waveform,
  }));
}

function attachmentIdentity(attachment: { fileId?: string; path?: string; name?: string; isDir?: boolean } | null | undefined): string {
  return [
    attachment?.fileId || '',
    attachment?.path || '',
    attachment?.name || '',
    attachment?.isDir ? '1' : '0',
  ].join('\0');
}

/** Empty lists are equal. Callers use inequality to send an explicit snapshot, including []. */
export function userAttachmentSnapshotsEqual(
  left?: Array<{ fileId?: string; path?: string; name?: string; isDir?: boolean }> | null,
  right?: Array<{ fileId?: string; path?: string; name?: string; isDir?: boolean }> | null,
): boolean {
  const a = left || [];
  const b = right || [];
  if (a.length !== b.length) return false;
  return a.every((item, index) => attachmentIdentity(item) === attachmentIdentity(b[index]));
}

export function attachedFilesFromNativePaths(paths: string[]): AttachedFile[] {
  return paths.map((filePath) => ({
    path: filePath,
    name: filePath.replace(/^.*[\\/]/, '') || filePath,
    isDirectory: false,
  }));
}

async function readBlobAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('file read failed'));
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : '';
      const comma = value.indexOf(',');
      resolve(comma >= 0 ? value.slice(comma + 1) : value);
    };
    reader.readAsDataURL(blob);
  });
}

export async function uploadChatFilesAsAttachments(opts: {
  files: File[];
  sessionPath?: string | null;
}): Promise<AttachedFile[]> {
  const uploaded: AttachedFile[] = [];
  for (const file of opts.files) {
    const mimeType = file.type || 'application/octet-stream';
    const base64Data = await readBlobAsBase64(file);
    const uploadPayload = mimeType.startsWith('image/')
      ? await prepareChatImageUpload({
        file,
        name: file.name,
        base64Data,
        mimeType,
      })
      : { name: file.name, base64Data, mimeType, compressed: false };
    const res = await hanaFetch('/api/upload-blob', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: uploadPayload.name,
        base64Data: uploadPayload.base64Data,
        mimeType: uploadPayload.mimeType,
        ...(opts.sessionPath ? { sessionPath: opts.sessionPath } : {}),
      }),
    });
    const data = await res.json();
    const upload = data?.uploads?.[0];
    if (!upload?.dest) {
      throw new Error(typeof upload?.error === 'string' && upload.error.trim()
        ? upload.error
        : 'upload failed');
    }
    uploaded.push({
      fileId: upload.fileId,
      path: upload.dest,
      name: upload.name || uploadPayload.name,
      isDirectory: false,
      base64Data: uploadPayload.base64Data,
      mimeType: uploadPayload.mimeType,
    });
  }
  return uploaded;
}

export function splitClipboardImages(clipboard: DataTransfer | null): { paths: string[]; files: File[] } {
  const paths: string[] = [];
  const files: File[] = [];
  if (!clipboard) return { paths, files };
  for (const item of Array.from(clipboard.items || [])) {
    if (!item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (!file) continue;
    const filePath = window.platform?.getFilePath?.(file);
    if (filePath) paths.push(filePath);
    else files.push(file);
  }
  return { paths, files };
}
