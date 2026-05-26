import { forwardRef } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// CodeMirror's contentEditable does not render reliably in jsdom. We
// mock the component with a <textarea> that forwards onChange + the
// `placeholder` prop, which is everything the integration test needs
// to assert against. The mock has to be declared BEFORE the import
// below so vitest hoists it correctly.
vi.mock('@uiw/react-codemirror', () => {
  const FakeCodeMirror = forwardRef<
    HTMLTextAreaElement,
    {
      value?: string;
      onChange?: (next: string) => void;
      placeholder?: string;
      editable?: boolean;
      readOnly?: boolean;
    }
  >(function FakeCodeMirror(props, ref) {
    return (
      <textarea
        ref={ref}
        data-testid="cm-textarea"
        value={props.value ?? ''}
        placeholder={props.placeholder}
        readOnly={props.readOnly}
        disabled={props.editable === false}
        onChange={(e) => props.onChange?.(e.target.value)}
      />
    );
  });
  return {
    default: FakeCodeMirror,
    EditorView: {
      lineWrapping: { extension: 'mock-lineWrapping' },
    },
  };
});

vi.mock('@codemirror/lang-html', () => ({
  html: () => ({ extension: 'mock-lang-html' }),
}));

vi.mock('@codemirror/view', () => ({
  EditorView: {
    lineWrapping: { extension: 'mock-lineWrapping' },
  },
}));

import { HtmlSourceEditor } from './HtmlSourceEditor';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('HtmlSourceEditor', () => {
  it('renders CodeMirror with the initial value', () => {
    render(<HtmlSourceEditor value="<p>hi</p>" onChange={() => undefined} />);
    const ta = screen.getByTestId('cm-textarea') as HTMLTextAreaElement;
    expect(ta.value).toBe('<p>hi</p>');
  });

  it('passes the placeholder through to the editor', () => {
    render(
      <HtmlSourceEditor
        value=""
        placeholder="Ask an agent to generate, or type HTML"
        onChange={() => undefined}
      />,
    );
    const ta = screen.getByTestId('cm-textarea') as HTMLTextAreaElement;
    expect(ta.placeholder).toBe('Ask an agent to generate, or type HTML');
  });

  it('fires onChange on each keystroke', () => {
    const onChange = vi.fn();
    render(<HtmlSourceEditor value="" onChange={onChange} />);
    const ta = screen.getByTestId('cm-textarea') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '<p>x</p>' } });
    expect(onChange).toHaveBeenCalledWith('<p>x</p>');
  });

  it('debounces onSave by the configured delay', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const onSave = vi.fn();
    render(
      <HtmlSourceEditor
        value=""
        onChange={onChange}
        onSave={onSave}
        saveDebounceMs={500}
      />,
    );
    const ta = screen.getByTestId('cm-textarea') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '<p>a</p>' } });
    // Still inside debounce window: no save yet.
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(onSave).not.toHaveBeenCalled();
    // Past the debounce: save fires with the latest value.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('<p>a</p>');
  });

  it('only saves the latest value when changes coalesce', () => {
    vi.useFakeTimers();
    const onSave = vi.fn();
    render(
      <HtmlSourceEditor
        value=""
        onChange={() => undefined}
        onSave={onSave}
        saveDebounceMs={300}
      />,
    );
    const ta = screen.getByTestId('cm-textarea') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'a' } });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.change(ta, { target: { value: 'ab' } });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.change(ta, { target: { value: 'abc' } });
    // Resets timer on every keystroke; only one save after final.
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('abc');
  });

  it('does not call onSave when the value matches the last-saved baseline', () => {
    vi.useFakeTimers();
    const onSave = vi.fn();
    render(
      <HtmlSourceEditor
        value="<p>same</p>"
        onChange={() => undefined}
        onSave={onSave}
        saveDebounceMs={100}
      />,
    );
    const ta = screen.getByTestId('cm-textarea') as HTMLTextAreaElement;
    // Type the same value we started with: onChange fires but the
    // debounce-tail save is suppressed.
    fireEvent.change(ta, { target: { value: '<p>same</p>' } });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onSave).not.toHaveBeenCalled();
  });
});
