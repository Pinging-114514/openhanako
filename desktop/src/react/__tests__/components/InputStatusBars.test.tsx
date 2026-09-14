// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InputStatusBars } from '../../components/input/InputStatusBars';

describe('InputStatusBars', () => {
  it('shows an indeterminate screenshot progress bar above the chat input', () => {
    render(
      <InputStatusBars
        slashBusy={null}
        slashBusyLabel="执行中..."
        compacting={false}
        compactingLabel="上下文压缩中"
        screenshotBusy
        screenshotLabel="正在截图"
        screenshotPageLabel="正在截图，第 2/4 页"
        screenshotProgress={{
          completedBlocks: 12,
          totalBlocks: 37,
          currentPage: 2,
          totalPages: 4,
        }}
        slashResult={null}
        onResultClick={undefined}
      />,
    );

    expect(screen.getByText('正在截图，第 2/4 页')).toBeInTheDocument();
    const progress = screen.getByRole('progressbar', { name: '正在截图，第 2/4 页' });
    expect(progress).toHaveAttribute('aria-valuenow', '12');
    expect(progress).toHaveAttribute('aria-valuemax', '37');
  });

  it('makes clickable results keyboard-accessible with Enter and Space', () => {
    const onResultClick = vi.fn();
    render(
      <InputStatusBars
        slashBusy={null}
        slashBusyLabel=""
        compacting={false}
        compactingLabel=""
        screenshotBusy={false}
        screenshotLabel=""
        slashResult={{ text: '截图已保存', type: 'success', filePath: '/tmp/card.png' }}
        onResultClick={onResultClick}
      />,
    );

    const result = screen.getByRole('button', { name: '截图已保存' });
    expect(result).toHaveAttribute('tabindex', '0');

    fireEvent.keyDown(result, { key: 'Enter' });
    fireEvent.keyDown(result, { key: ' ' });

    expect(onResultClick).toHaveBeenCalledTimes(2);
  });

  it('keeps non-clickable results outside the keyboard button contract', () => {
    render(
      <InputStatusBars
        slashBusy={null}
        slashBusyLabel=""
        compacting={false}
        compactingLabel=""
        screenshotBusy={false}
        screenshotLabel=""
        slashResult={{ text: '操作失败', type: 'error' }}
        onResultClick={undefined}
      />,
    );

    expect(screen.queryByRole('button', { name: '操作失败' })).not.toBeInTheDocument();
    expect(screen.getByText('操作失败')).not.toHaveAttribute('tabindex');
  });

  it('keeps clickable result hover and focus feedback on the solid panel background', () => {
    const css = fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/react/components/input/InputArea.module.css'),
      'utf8',
    );

    expect(css).toMatch(
      /\.slash-busy-bar-clickable:hover,\s*\.slash-busy-bar-clickable:focus-visible\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--panel-card-bg\) 96%, var\(--text\) 4%\);/s,
    );
  });
});
