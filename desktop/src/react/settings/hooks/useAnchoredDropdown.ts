import { useCallback, useEffect, useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

interface UseAnchoredDropdownOptions {
  open: boolean;
  triggerRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  widthOffset?: number;
  gap?: number;
  viewportPadding?: number;
  zIndex?: number;
}

export function useAnchoredDropdown({
  open,
  triggerRef,
  panelRef,
  onClose,
  widthOffset = 0,
  gap = 4,
  viewportPadding = 8,
  zIndex = 9999,
}: UseAnchoredDropdownOptions): CSSProperties {
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});

  const isInside = useCallback((target: EventTarget | null) => {
    const node = target instanceof Node ? target : null;
    if (!node) return false;
    if (triggerRef.current?.contains(node)) return true;
    if (panelRef.current?.contains(node)) return true;
    return false;
  }, [panelRef, triggerRef]);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!open || !trigger) return;

    const rect = trigger.getBoundingClientRect();
    const width = rect.width + widthOffset;
    const maxLeft = window.innerWidth - width - viewportPadding;
    const left = Math.max(viewportPadding, Math.min(rect.left, maxLeft));

    setPanelStyle({
      position: 'fixed',
      left,
      width,
      top: rect.bottom + gap,
      maxHeight: Math.max(120, window.innerHeight - rect.bottom - viewportPadding - gap),
      zIndex,
    });
  }, [gap, open, triggerRef, viewportPadding, widthOffset, zIndex]);

  useLayoutEffect(() => {
    updatePosition();
  }, [updatePosition]);

  useEffect(() => {
    if (!open) return;
    const handleWindowChange = (event: Event) => {
      if (event.type === 'scroll' && isInside(event.target)) return;
      updatePosition();
    };
    window.addEventListener('resize', handleWindowChange);
    window.addEventListener('scroll', handleWindowChange, true);
    return () => {
      window.removeEventListener('resize', handleWindowChange);
      window.removeEventListener('scroll', handleWindowChange, true);
    };
  }, [isInside, open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (isInside(event.target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    // Wait out the opening click and the autoFocus scroll-into-view, otherwise
    // the panel appears and immediately dismisses itself.
    const timer = window.setTimeout(() => {
      document.addEventListener('mousedown', onPointerDown);
      document.addEventListener('keydown', onKeyDown);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isInside, onClose, open]);

  return panelStyle;
}
