/**
 * Mouse wheel scroll hook
 *
 * Enables SGR mouse protocol on the terminal to capture scroll wheel events.
 * Returns the current scroll offset in visual lines (0 = bottom/latest).
 * Each scroll wheel tick moves 3 lines.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useStdin, useStdout } from 'ink';

interface UseMouseScrollOptions {
  /** Maximum scroll offset (total visual lines minus viewport height) */
  maxOffset: number;
  /** Whether scrolling is enabled (disable during overlays) */
  enabled?: boolean;
}

interface UseMouseScrollResult {
  scrollOffset: number;
  setScrollOffset: (offset: number | ((prev: number) => number)) => void;
  /** Whether the user has scrolled up from the bottom */
  isScrolledUp: boolean;
  /** Scroll to the bottom (offset = 0) */
  scrollToBottom: () => void;
}

export function useMouseScroll({ maxOffset, enabled = true }: UseMouseScrollOptions): UseMouseScrollResult {
  const { stdin, setRawMode } = useStdin();
  const { stdout } = useStdout();
  const [scrollOffset, setScrollOffset] = useState(0);
  const scrollOffsetRef = useRef(scrollOffset);
  scrollOffsetRef.current = scrollOffset;
  const maxOffsetRef = useRef(maxOffset);
  maxOffsetRef.current = maxOffset;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // Clamp scroll offset when maxOffset shrinks
  useEffect(() => {
    setScrollOffset(prev => Math.min(prev, Math.max(0, maxOffset)));
  }, [maxOffset]);

  // Enable SGR mouse mode on mount, disable on cleanup
  useEffect(() => {
    if (!stdout) return;

    // Enable mouse tracking (button events) + SGR extended coordinates
    stdout.write('\x1b[?1000h'); // Enable mouse button tracking
    stdout.write('\x1b[?1006h'); // Enable SGR extended mouse mode

    return () => {
      stdout.write('\x1b[?1000l'); // Disable mouse button tracking
      stdout.write('\x1b[?1006l'); // Disable SGR extended mouse mode
    };
  }, [stdout]);

  // Parse SGR mouse escape sequences from stdin
  useEffect(() => {
    if (!stdin) return;

    // Buffer for accumulating partial escape sequences
    let buffer = '';

    const onData = (data: Buffer) => {
      if (!enabledRef.current) return;

      buffer += data.toString('utf-8');

      // Process all complete SGR mouse sequences in the buffer
      // Format: \x1b[<button;x;yM or \x1b[<button;x;ym
      const sgrPattern = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
      let match: RegExpExecArray | null;
      let lastIndex = 0;

      while ((match = sgrPattern.exec(buffer)) !== null) {
        const button = parseInt(match[1], 10);
        // const x = parseInt(match[2], 10);
        // const y = parseInt(match[3], 10);
        const suffix = match[4];

        // Only process button press events (M), not releases (m)
        if (suffix === 'M') {
          // Button 64 = scroll up, Button 65 = scroll down
          if (button === 64) {
            // Scroll up (view older messages)
            setScrollOffset(prev => Math.min(prev + 3, Math.max(0, maxOffsetRef.current)));
          } else if (button === 65) {
            // Scroll down (view newer messages)
            setScrollOffset(prev => Math.max(0, prev - 3));
          }
        }

        lastIndex = sgrPattern.lastIndex;
      }

      // Keep any incomplete sequence at the end of the buffer
      if (lastIndex > 0) {
        buffer = buffer.slice(lastIndex);
      }

      // Prevent buffer from growing unbounded with non-mouse data
      if (buffer.length > 100) {
        buffer = buffer.slice(-20);
      }
    };

    stdin.on('data', onData);
    return () => {
      stdin.off('data', onData);
    };
  }, [stdin]);

  const scrollToBottom = useCallback(() => {
    setScrollOffset(0);
  }, []);

  return {
    scrollOffset,
    setScrollOffset,
    isScrolledUp: scrollOffset > 0,
    scrollToBottom,
  };
}
