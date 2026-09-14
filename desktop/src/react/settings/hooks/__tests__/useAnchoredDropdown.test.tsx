/**
 * @vitest-environment jsdom
 */

import React, { useRef, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useAnchoredDropdown } from '../useAnchoredDropdown';

function Harness() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelStyle = useAnchoredDropdown({
    open,
    triggerRef,
    panelRef,
    onClose: () => setOpen(false),
  });

  return (
    <div>
      <button type="button" ref={triggerRef} onClick={() => setOpen(true)}>添加模型</button>
      {open ? (
        <div ref={panelRef} data-testid="dropdown-panel" style={panelStyle}>
          <input autoFocus aria-label="search" />
        </div>
      ) : null}
    </div>
  );
}

describe('useAnchoredDropdown', () => {
  afterEach(() => {
    cleanup();
  });

  it('does not close when opening autoFocus causes a page scroll', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    expect(screen.getByTestId('dropdown-panel')).toBeInTheDocument();

    window.dispatchEvent(new Event('scroll', { bubbles: true }));
    document.body.dispatchEvent(new Event('scroll', { bubbles: true }));

    expect(screen.getByTestId('dropdown-panel')).toBeInTheDocument();
  });

  it('closes on a later outside mousedown, not the opening click', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    expect(screen.getByTestId('dropdown-panel')).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.getByTestId('dropdown-panel')).toBeInTheDocument();

    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('dropdown-panel')).not.toBeInTheDocument();
  });
});
