import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStageFilesTool, normalizeStageFilesParams } from '../lib/tools/output-file-tool.ts';
import { resolveToolInvocationPermission } from '../lib/permission/tool-invocation-permission.ts';
import { wrapWithSessionPermission } from '../lib/tools/session-permission-wrapper.ts';

const absolute = path.resolve('stage-fixture.pdf');
const ctx = { sessionManager: { getSessionFile: () => path.resolve('fixture-session.jsonl') } };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-stage-placeholders-')); roots.push(root);
  const file = path.join(root, 'draft.pdf'); fs.writeFileSync(file, 'fixture'); return file;
}

describe('stage_files placeholder compatibility', () => {
  it.each([
    { fileIds: [''], fileId: '', filepaths: [absolute], filePath: '', label: '' },
    { fileIds: [], fileId: '', filepaths: [absolute], filePath: '' },
    { fileIds: [' ', '\t'], filepaths: ['', absolute, ' '] },
    { fileIds: null, fileId: null, filepaths: [absolute] },
    { fileIds: [''], filepaths: [''], filePath: absolute },
  ])('accepts valid paths with unused placeholders: %j', (params) => {
    expect(normalizeStageFilesParams(params)).toEqual({ ok: true, value: { fileIds: [], filepaths: [absolute] } });
    const permission = resolveToolInvocationPermission(createStageFilesTool({}) as any, params);
    expect(permission.ok).toBe(true);
  });

  it('accepts ID delivery with empty path fields and preserves ID spelling', () => {
    expect(normalizeStageFilesParams({ fileIds: ['sf_real', ''], fileId: '', filepaths: [''], filePath: '' })).toEqual({ ok: true, value: { fileIds: ['sf_real'], filepaths: [] } });
    expect(normalizeStageFilesParams({ fileIds: [''], fileId: 'sf_single' })).toEqual({ ok: true, value: { fileIds: ['sf_single'], filepaths: [] } });
    expect(normalizeStageFilesParams({ fileIds: [' sf_real '], filepaths: [absolute] }).ok).toBe(false);
  });

  it.each([{}, { fileIds: [''], filepaths: [''], fileId: '', filePath: '' }, { fileIds: [], filepaths: [], fileId: null, filePath: null }])('rejects empty delivery with an actionable diagnostic: %j', async (params) => {
    const tool = createStageFilesTool({});
    const [wrapped] = wrapWithSessionPermission([tool], { getPermissionMode: () => 'auto' });
    const result = await wrapped.execute('empty', params, null, null, ctx);
    expect(result.details.errorCode).toBe('STAGE_FILES_INVALID_PARAMS');
    expect(result.content[0].text).toContain('at least one non-empty');
    expect(result.isError).toBe(true);
  });

  it.each([
    { fileIds: [5], filepaths: [absolute] },
    { fileIds: [null], filepaths: [absolute] },
    { fileIds: 'sf_bad', filepaths: [absolute] },
    { filepaths: [absolute, {}] },
    { filepaths: 'not-an-array' },
    { filepaths: ['relative.pdf'] },
  ])('still rejects malformed non-placeholder values: %j', async (params) => {
    expect(normalizeStageFilesParams(params).ok).toBe(false);
    const tool = createStageFilesTool({});
    const execute = vi.spyOn(tool, 'execute');
    const [wrapped] = wrapWithSessionPermission([tool], { getPermissionMode: () => 'auto' });
    const result = await wrapped.execute('invalid', params, null, null, ctx);
    expect(result.details.errorCode).toBe('STAGE_FILES_INVALID_PARAMS');
    expect(execute).not.toHaveBeenCalled();
  });

  it('delivers the reported parameter shape through the real permission wrapper', async () => {
    const file = fs.realpathSync(fixture());
    const checkStagePath = vi.fn((p: string) => ({ allowed: p === file, canonicalPath: p }));
    const registerSessionFile = vi.fn(({ filePath, label }) => ({ fileId: 'sf_test', filePath, label, filename: path.basename(filePath) }));
    const tool = createStageFilesTool({ registerSessionFile });
    const [wrapped] = wrapWithSessionPermission([tool], { getPermissionMode: () => 'auto', permissionBoundary: { checkStagePath } });
    const result = await wrapped.execute('real-shape', { fileIds: [''], fileId: '', filepaths: [file], filePath: '', label: '' }, null, null, ctx);
    expect(result.details.files).toHaveLength(1);
    expect(result.details.files[0].fileId).toBe('sf_test');
    expect(registerSessionFile).toHaveBeenCalledTimes(1);
    expect(checkStagePath).toHaveBeenCalledWith(file);
  });

  it('does not allow blank placeholders to bypass workspace protection', async () => {
    const file = fixture();
    const registerSessionFile = vi.fn();
    const tool = createStageFilesTool({ registerSessionFile });
    const resolver = vi.spyOn(tool.sessionPermission, 'resolveInvocation');
    const [wrapped] = wrapWithSessionPermission([tool], { getPermissionMode: () => 'auto', permissionBoundary: { checkStagePath: () => ({ allowed: false, reason: 'outside workspace' }) } });
    const result = await wrapped.execute('blocked', { fileIds: [''], filepaths: [file], filePath: '' }, null, null, ctx);
    expect(result.details.errorCode).toBe('ACTION_BLOCKED_BY_WORKSPACE_BOUNDARY');
    expect(resolver).not.toHaveBeenCalled();
    expect(registerSessionFile).not.toHaveBeenCalled();
  });

  it('surfaces partial delivery errors rather than silently hiding invalid IDs', async () => {
    const file = fixture();
    const tool = createStageFilesTool({ resolveSessionFile: async () => null });
    const result = await tool.execute('partial', { fileIds: ['sf_missing'], filepaths: [file] }, null, null, ctx);
    expect(result.details.files).toHaveLength(1);
    expect(result.details.partialFailure).toBe(true);
    expect(result.content[0].text).toContain('SessionFile not found: sf_missing');
    expect(result.details.errors).toContain('SessionFile not found: sf_missing');
  });

  it('marks complete delivery failure as an error with the concrete reason', async () => {
    const tool = createStageFilesTool({ resolveSessionFile: async () => null });
    const result = await tool.execute('missing', { fileIds: ['sf_missing'], filepaths: [''] }, null, null, ctx);
    expect(result.isError).toBe(true);
    expect(result.details.errorCode).toBe('STAGE_FILES_DELIVERY_FAILED');
    expect(result.content[0].text).toContain('sf_missing');
  });
});
