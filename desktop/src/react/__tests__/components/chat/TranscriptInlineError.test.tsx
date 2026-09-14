// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TranscriptInlineError } from '../../../components/chat/TranscriptInlineError';
import { installWindowTestT } from '../../helpers/i18n-test-strings';

describe('TranscriptInlineError', () => {
  beforeEach(() => {
    installWindowTestT({
      'error.detailShow': '详情',
      'error.detailHide': '收起',
    });
  });

  afterEach(cleanup);

  it('shows the human sentence and hides the technical detail until asked', () => {
    render(<TranscriptInlineError
      error={{
        text: '这条消息之后还有任务在跑，等它结束再从这里分支',
        detail: 'active task cannot be shared by a session fork: subagent-1785635522479-v82otz',
        code: 'session_fork_active_task',
      }}
    />);

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('这条消息之后还有任务在跑，等它结束再从这里分支')).toBeInTheDocument();
    expect(screen.queryByText(/subagent-1785635522479/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '详情' }));

    expect(screen.getByText(/subagent-1785635522479/)).toBeInTheDocument();
    expect(screen.getByText('session_fork_active_task')).toBeInTheDocument();
  });

  it('collapses again on a second click', () => {
    render(<TranscriptInlineError
      error={{ text: '出了点意外', detail: "version `GLIBC_2.29' not found", code: null }}
    />);

    fireEvent.click(screen.getByRole('button', { name: '详情' }));
    expect(screen.getByText(/GLIBC_2.29/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(screen.queryByText(/GLIBC_2.29/)).not.toBeInTheDocument();
  });

  it('offers no toggle when the error carries nothing extra to show', () => {
    render(<TranscriptInlineError
      error={{ text: '会话正忙，稍后再试', detail: null, code: null }}
    />);

    expect(screen.getByText('会话正忙，稍后再试')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '详情' })).not.toBeInTheDocument();
  });

  it('re-collapses when a different error replaces the current one', () => {
    const { rerender } = render(<TranscriptInlineError
      error={{ text: '第一个错误', detail: 'first detail', code: null }}
    />);

    fireEvent.click(screen.getByRole('button', { name: '详情' }));
    expect(screen.getByText('first detail')).toBeInTheDocument();

    rerender(<TranscriptInlineError
      error={{ text: '第二个错误', detail: 'second detail', code: null }}
    />);

    expect(screen.queryByText('second detail')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '详情' })).toBeInTheDocument();
  });
});
