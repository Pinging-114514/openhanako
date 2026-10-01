import { memo } from 'react';
import { AttachmentChip } from '../shared/AttachmentChip';
import { AudioAttachmentChip } from '../shared/AudioAttachmentChip';
import { FolderIcon } from '../shared/FolderIcon';
import { isMediaKind, kindOfFileName } from '../../utils/file-kind';
import { openAttachmentFile } from '../../utils/file-preview';
import { openMediaViewerForInputAttachments } from '../../utils/open-media-viewer';
import styles from './InputArea.module.css';

type AttachedBarFile = {
  path: string;
  name: string;
  isDirectory?: boolean;
  fileId?: string;
  base64Data?: string;
  mimeType?: string;
};

export const AttachedFilesBar = memo(function AttachedFilesBar({ files, onRemove }: {
  files: AttachedBarFile[];
  onRemove: (index: number) => void;
}) {
  return (
    <div className={styles['attached-files']}>
      {files.map((f, i) => {
        const kind = f.isDirectory ? 'directory' : kindOfFileName(f.name || f.path, f.mimeType);
        if (kind === 'audio') {
          return (
            <AudioAttachmentChip
              key={f.path}
              file={f}
              onRemove={() => onRemove(i)}
            />
          );
        }
        if (kind === 'image' || kind === 'svg') {
          return (
            <ImageAttachmentChip
              key={f.path}
              file={f}
              files={files}
              onRemove={() => onRemove(i)}
            />
          );
        }
        return (
          <AttachmentChip
            key={f.path}
            icon={f.isDirectory ? <FolderIcon /> : <ClipIcon />}
            name={f.name}
            onOpen={f.isDirectory || !f.path ? undefined : () => { void openAttachmentFile(f.path, f.name); }}
            openLabel={f.isDirectory || !f.path ? undefined : attachmentPreviewLabel(f.name)}
            onRemove={() => onRemove(i)}
          />
        );
      })}
    </div>
  );
});

function ImageAttachmentChip({
  file,
  files,
  onRemove,
}: {
  file: AttachedBarFile;
  files: AttachedBarFile[];
  onRemove: () => void;
}) {
  const src = getMediaUrl(file);
  const canPreview = canPreviewAttachment(file);
  const previewLabel = attachmentPreviewLabel(file.name);

  return (
    <span className={styles['media-attachment-chip']} title={file.name}>
      <button
        type="button"
        className={styles['media-attachment-open']}
        onClick={() => {
          if (!canPreview) return;
          openMediaViewerForInputAttachments(files, file);
        }}
        disabled={!canPreview}
        aria-label={previewLabel}
      >
        <span className={styles['image-attachment-preview']} aria-hidden="true">
          {src ? (
            <img src={src} alt="" />
          ) : (
            <ClipIcon />
          )}
        </span>
        <span className={styles['media-attachment-name']}>{file.name}</span>
      </button>
      <RemoveButton name={file.name} onRemove={onRemove} />
    </span>
  );
}

function RemoveButton({ name, onRemove }: { name: string; onRemove: () => void }) {
  return (
    <button
      type="button"
      className={styles['media-attachment-remove']}
      onClick={onRemove}
      aria-label={`Remove ${name}`}
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  );
}

function canPreviewAttachment(file: AttachedBarFile) {
  if (file.isDirectory) return false;
  const kind = kindOfFileName(file.name || file.path, file.mimeType);
  if (!isMediaKind(kind)) return false;
  return !!(file.path || (file.base64Data && file.mimeType));
}

function attachmentPreviewLabel(name: string) {
  const translate = typeof window !== 'undefined' ? window.t : undefined;
  return translate?.('input.previewAttachment', { name }) || `Preview ${name}`;
}

function getMediaUrl(file: { path: string; base64Data?: string; mimeType?: string }) {
  if (file.base64Data && file.mimeType) {
    return `data:${file.mimeType};base64,${file.base64Data}`;
  }
  if (typeof window === 'undefined') return null;
  return window.platform?.getFileUrl?.(file.path) || null;
}

function ClipIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}
