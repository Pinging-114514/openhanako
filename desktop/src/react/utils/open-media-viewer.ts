import { useStore } from '../stores';
import { selectDeskFiles, selectSessionFiles } from '../stores/selectors/file-refs';
import type { FileRef, FileKind, FileSource } from '../types/file-ref';
import { extOfName, isMediaKind, buildFileRefId, kindOfFileName } from './file-kind';

export interface InputAttachmentMedia {
  path?: string;
  name: string;
  fileId?: string;
  base64Data?: string;
  mimeType?: string;
  isDirectory?: boolean;
}

interface OpenInput {
  filePath: string;
  fileId?: string;
  label: string;
  ext: string;
  kind: FileKind;
  /**
   * 显式来源。不传时保守默认 'desk'。
   * 不要靠 state.currentSessionPath 推导：用户可能在非聚焦 transcript / 只读视图里点击。
   */
  origin?: 'desk' | 'session';
  /** origin === 'session' 时调用方必传（从 prop 而非 store 读取） */
  sessionPath?: string;
  /** session 场景：消息 id，用于精准定位消息内 attachment/block */
  messageId?: string;
  /** session-block-* 场景：block 在 msg.blocks 中的索引 */
  blockIdx?: number;
}

export function openMediaViewerFromContext(input: OpenInput): void {
  const state = useStore.getState();
  const origin = input.origin ?? 'desk';
  const sessionPath = input.sessionPath ?? '';

  const rawFiles: readonly FileRef[] = origin === 'session'
    ? selectSessionFiles(state, sessionPath)
    : selectDeskFiles(state);
  const files = rawFiles.filter(f => isMediaKind(f.kind));

  // 按 id 匹配（不是 path）—— id 由 buildFileRefId 统一生成
  const startId = origin === 'session'
    ? buildFileRefId({
        source: input.blockIdx !== undefined ? 'session-block-file' : 'session-attachment',
        sessionPath,
        messageId: input.messageId,
        blockIdx: input.blockIdx,
        path: input.filePath,
      })
    : buildFileRefId({ source: 'desk', path: input.filePath });

  const startRef = files.find(f => f.id === startId)
    ?? findMediaRefByStableIdentity(files, input);
  if (!startRef) {
    // 防御：序列里找不到（外部 ad-hoc / 新文件尚未加载）→ solo 序列
    const soloSource: FileSource = origin === 'desk'
      ? 'desk'
      : input.blockIdx !== undefined
        ? 'session-block-file'
        : 'session-attachment';
    const solo: FileRef = {
      id: startId,
      kind: input.kind,
      source: soloSource,
      name: input.label,
      path: input.filePath,
      fileId: input.fileId,
      ext: input.ext,
      sessionMessageId: input.messageId,
    };
    state.setMediaViewer({ files: [solo], currentId: solo.id, origin });
    return;
  }

  state.setMediaViewer({ files, currentId: startRef.id, origin });
}

// fork 出来的 session 里，历史消息的 marker 还写着父 session 的文件 id 和路径，
// 账本条目已经换成新的并把旧值记成别名。别名不认就会误判成“序列里没有这个文件”，
// 白白退化成 solo 序列，丢掉左右翻页和 resource link。
function findMediaRefByStableIdentity(files: readonly FileRef[], input: OpenInput): FileRef | undefined {
  const { fileId, filePath } = input;
  if (fileId) {
    const byFileId = files.find(f => (
      f.fileId === fileId
      || (f.legacyFileIds || []).includes(fileId)
    ));
    if (byFileId) return byFileId;
  }
  if (filePath) {
    return files.find(f => (
      f.path === filePath
      || (f.legacyFilePaths || []).includes(filePath)
    ));
  }
  return undefined;
}

/**
 * 直接用已构造的 FileRef 打开 —— 给 screenshot 等**无 path** media 用。
 * 内部按 ref.id 在 session 序列里找匹配；命中则融入序列，否则 solo。
 * 不再"绕过统一入口直接 setMediaViewer"。
 */
export function openMediaViewerForRef(ref: FileRef, opts: {
  origin: 'desk' | 'session';
  sessionPath?: string;
}): void {
  const state = useStore.getState();
  const rawFiles: readonly FileRef[] = opts.origin === 'session'
    ? selectSessionFiles(state, opts.sessionPath ?? '')
    : selectDeskFiles(state);
  const files = rawFiles.filter(f => isMediaKind(f.kind));
  const match = files.find(f => f.id === ref.id);
  if (match) {
    state.setMediaViewer({ files, currentId: ref.id, origin: opts.origin });
  } else {
    state.setMediaViewer({ files: [ref], currentId: ref.id, origin: opts.origin });
  }
}

/**
 * 输入框草稿附件：还没进 session / desk 序列，自己组成一轮预览。
 * 粘贴图可能只有 base64（Quick Chat 的 path 甚至只是本地 id），不能走 desk path 查找。
 */
export function buildInputAttachmentMediaRefs(
  files: readonly InputAttachmentMedia[],
): FileRef[] {
  const refs: FileRef[] = [];
  files.forEach((file, index) => {
    const ref = inputAttachmentToMediaRef(file, index);
    if (ref) refs.push(ref);
  });
  return refs;
}

export function openMediaViewerForInputAttachments(
  files: readonly InputAttachmentMedia[],
  start: Pick<InputAttachmentMedia, 'path' | 'name' | 'fileId' | 'base64Data'>,
): void {
  const refs = buildInputAttachmentMediaRefs(files);
  if (refs.length === 0) return;
  const startRef = findInputAttachmentStart(refs, files, start) ?? refs[0];
  useStore.getState().setMediaViewer({
    files: refs,
    currentId: startRef.id,
    origin: 'desk',
  });
}

function inputAttachmentToMediaRef(file: InputAttachmentMedia, index: number): FileRef | null {
  if (file.isDirectory) return null;
  const kind = kindOfFileName(file.name || file.path || '', file.mimeType);
  if (!isMediaKind(kind)) return null;
  const path = file.path || '';
  const hasInline = !!(file.base64Data && file.mimeType);
  if (!path && !hasInline) return null;
  return {
    id: `input-att:${index}:${file.fileId || path || file.name}`,
    fileId: file.fileId,
    kind,
    source: 'desk',
    name: file.name || path.split(/[\\/]/).pop() || 'image',
    path,
    ext: extOfName(file.name || path),
    mime: file.mimeType,
    inlineData: hasInline ? { base64: file.base64Data!, mimeType: file.mimeType! } : undefined,
  };
}

function findInputAttachmentStart(
  refs: readonly FileRef[],
  files: readonly InputAttachmentMedia[],
  start: Pick<InputAttachmentMedia, 'path' | 'name' | 'fileId' | 'base64Data'>,
): FileRef | undefined {
  const startIndex = files.findIndex((file) => (
    (!!start.fileId && file.fileId === start.fileId)
    || (!!start.path && !!file.path && file.path === start.path)
    || (!!start.base64Data && file.base64Data === start.base64Data && file.name === start.name)
    || (!start.fileId && !start.path && !start.base64Data && file.name === start.name)
  ));
  if (startIndex < 0) return undefined;
  const startIdPrefix = `input-att:${startIndex}:`;
  return refs.find((ref) => ref.id.startsWith(startIdPrefix));
}
