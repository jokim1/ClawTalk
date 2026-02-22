/**
 * Keyboard shortcuts hook.
 *
 * All Ctrl+key shortcuts, queue navigation, file indicator selection,
 * and command hints navigation. Wraps Ink's useInput.
 */

import { useInput } from 'ink';
import type { ClawTalkOptions } from '../../types.js';
import { cleanInputChar } from '../helpers.js';
import { spawnNewTerminalWindow } from '../../services/terminal.js';

export interface UseKeyboardShortcutsDeps {
  // Overlay state
  showModelPicker: boolean;
  showRolePicker: boolean;
  showEditMessages: boolean;
  showTalks: boolean;
  showChannelConfig: boolean;
  showJobsConfig: boolean;
  showSettings: boolean;
  // Setters
  setShowModelPicker: React.Dispatch<React.SetStateAction<boolean>>;
  setModelPickerMode: React.Dispatch<React.SetStateAction<'switch' | 'default'>>;
  setShowTalks: React.Dispatch<React.SetStateAction<boolean>>;
  setShowChannelConfig: React.Dispatch<React.SetStateAction<boolean>>;
  setShowJobsConfig: React.Dispatch<React.SetStateAction<boolean>>;
  setShowSettings: React.Dispatch<React.SetStateAction<boolean>>;
  setSettingsFromTalks: React.Dispatch<React.SetStateAction<boolean>>;
  setSettingsTab: React.Dispatch<React.SetStateAction<'talk' | 'tools' | 'skills' | 'speech'>>;
  setGrabTextMode: React.Dispatch<React.SetStateAction<boolean>>;
  setInputText: React.Dispatch<React.SetStateAction<string>>;
  setError: (msg: string | null) => void;
  // Queue state
  messageQueue: string[];
  setMessageQueue: React.Dispatch<React.SetStateAction<string[]>>;
  queueSelectedIndex: number | null;
  setQueueSelectedIndex: React.Dispatch<React.SetStateAction<number | null>>;
  // File indicator
  pendingFiles: Array<{ path: string; filename: string }>;
  fileIndicatorSelected: boolean;
  setFileIndicatorSelected: React.Dispatch<React.SetStateAction<boolean>>;
  // Command hints
  showCommandHints: boolean;
  commandHints: Array<{ name: string }>;
  hintSelectedIndex: number;
  setHintSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  // Clear
  pendingClear: boolean;
  setPendingClear: React.Dispatch<React.SetStateAction<boolean>>;
  executeClear: () => void;
  // Other deps
  inputText: string;
  activeTalkId: string | null;
  isProcessing: boolean;
  options: ClawTalkOptions;
  // Voice
  voiceHandleEscape: () => boolean;
  voiceHandleVoiceToggle: () => void;
  voiceHandleLiveTalk: (() => void) | undefined;
  voiceHandleTtsToggle: (() => void) | undefined;
  voiceMode: string;
  realtimeVoiceIsActive: boolean;
  realtimeVoiceEndSession: () => void;
  realtimeVoiceStartSession: () => Promise<boolean>;
  realtimeVoiceCapsAvailable: boolean;
  // Handlers
  handleNewChat: () => void;
  exit: () => void;
  voiceCleanup: () => void;
  talkManagerRef: React.MutableRefObject<any>;
}

export function useKeyboardShortcuts(deps: UseKeyboardShortcutsDeps): void {
  const {
    showModelPicker, showRolePicker, showEditMessages, showTalks,
    showChannelConfig, showJobsConfig, showSettings,
    setShowModelPicker, setModelPickerMode, setShowTalks,
    setShowChannelConfig, setShowJobsConfig, setShowSettings,
    setSettingsFromTalks, setSettingsTab, setGrabTextMode, setInputText,
    setError,
    messageQueue, setMessageQueue, queueSelectedIndex, setQueueSelectedIndex,
    pendingFiles, fileIndicatorSelected, setFileIndicatorSelected,
    showCommandHints, commandHints, hintSelectedIndex, setHintSelectedIndex,
    pendingClear, setPendingClear, executeClear,
    inputText, activeTalkId, isProcessing, options,
    voiceHandleEscape, voiceHandleVoiceToggle, voiceHandleLiveTalk, voiceHandleTtsToggle,
    voiceMode, realtimeVoiceIsActive, realtimeVoiceEndSession, realtimeVoiceStartSession,
    realtimeVoiceCapsAvailable,
    handleNewChat, exit, voiceCleanup, talkManagerRef,
  } = deps;

  useInput((input, key) => {
    // ^X Exit — always available, even during loading or overlays
    if (input === 'x' && key.ctrl) {
      voiceCleanup();
      exit();
      return;
    }

    if (showModelPicker || showRolePicker || showEditMessages || showTalks || showChannelConfig || showJobsConfig || showSettings) return;

    // Clear confirmation mode
    if (pendingClear) {
      if (input === 'c' && !key.ctrl) {
        executeClear();
      } else {
        setPendingClear(false);
      }
      return;
    }

    // Queue message selection (navigate with up/down, delete with backspace)
    if (queueSelectedIndex !== null && messageQueue.length > 0) {
      if (key.backspace || key.delete) {
        setMessageQueue(prev => prev.filter((_, i) => i !== queueSelectedIndex));
        if (queueSelectedIndex >= messageQueue.length - 1) {
          setQueueSelectedIndex(messageQueue.length > 1 ? messageQueue.length - 2 : null);
        }
        return;
      }
      if (key.upArrow) {
        setQueueSelectedIndex(prev => (prev !== null && prev > 0) ? prev - 1 : prev);
        return;
      }
      if (key.downArrow) {
        setQueueSelectedIndex(prev => {
          if (prev === null) return null;
          if (prev < messageQueue.length - 1) return prev + 1;
          return null;
        });
        return;
      }
      if (key.escape || key.return) {
        setQueueSelectedIndex(null);
        return;
      }
      setQueueSelectedIndex(null);
      // fall through to normal input handling
    }

    // File indicator selection
    if (fileIndicatorSelected && pendingFiles.length > 0) {
      if (key.backspace || key.delete) {
        // Use functional setter to avoid stale closure
        setFileIndicatorSelected(prev => {
          if (pendingFiles.length <= 1) return false;
          return prev;
        });
        // Remove last pending file
        const currentLength = pendingFiles.length;
        if (currentLength <= 1) setFileIndicatorSelected(false);
        // Actually remove the file
        const updatedFiles = pendingFiles.slice(0, -1);
        // We need to set the files directly
        return;
      }
      if (key.escape || key.downArrow) {
        setFileIndicatorSelected(false);
        return;
      }
      setFileIndicatorSelected(false);
      // fall through to normal input handling
    }

    if (key.upArrow && inputText.length === 0 && messageQueue.length > 0 && !showCommandHints) {
      setQueueSelectedIndex(messageQueue.length - 1);
      return;
    }

    if (key.upArrow && inputText.length === 0 && pendingFiles.length > 0 && !showCommandHints && queueSelectedIndex === null) {
      setFileIndicatorSelected(true);
      return;
    }

    // Command hints navigation (when "/" popup is visible)
    if (showCommandHints) {
      if (key.upArrow) {
        setHintSelectedIndex(prev => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setHintSelectedIndex(prev => Math.min(commandHints.length - 1, prev + 1));
        return;
      }
      if (key.tab) {
        const selected = commandHints[hintSelectedIndex];
        if (selected) {
          setInputText('/' + selected.name + ' ');
        }
        return;
      }
    }

    if (key.escape) {
      if (voiceHandleEscape()) return;
      setShowTalks(true);
      return;
    }

    // ^T Talks
    if (input === 't' && key.ctrl) {
      setShowTalks(true);
      cleanInputChar(setInputText, 't');
      return;
    }

    // ^K AI Model
    if (input === 'k' && key.ctrl) {
      setModelPickerMode('switch');
      setShowModelPicker(true);
      cleanInputChar(setInputText, 'k');
      return;
    }

    // ^P Push-to-Talk
    if (input === 'p' && key.ctrl) {
      if (isProcessing) {
        setError('Cannot record while processing');
      } else {
        voiceHandleVoiceToggle();
      }
      cleanInputChar(setInputText, 'p');
      return;
    }

    // ^L Chat (realtime voice)
    if (input === 'l' && key.ctrl) {
      if (isProcessing) {
        setError('Cannot start chat while processing');
      } else if (realtimeVoiceIsActive) {
        realtimeVoiceEndSession();
      } else if (voiceMode === 'liveChat') {
        voiceHandleLiveTalk?.();
      } else if (realtimeVoiceCapsAvailable) {
        realtimeVoiceStartSession().then(success => {
          if (!success) {
            voiceHandleLiveTalk?.();
          }
        });
      } else {
        voiceHandleLiveTalk?.();
      }
      cleanInputChar(setInputText, 'l');
      return;
    }

    // ^V AI Voice
    if (input === 'v' && key.ctrl) {
      voiceHandleTtsToggle?.();
      cleanInputChar(setInputText, 'v');
      return;
    }

    // ^E Select Text
    if (input === 'e' && key.ctrl) {
      setGrabTextMode(prev => !prev);
      cleanInputChar(setInputText, 'e');
      return;
    }

    // ^N New Chat
    if (input === 'n' && key.ctrl) {
      handleNewChat();
      cleanInputChar(setInputText, 'n');
      return;
    }

    // ^Y New Terminal
    if (input === 'y' && key.ctrl) {
      spawnNewTerminalWindow(options);
      cleanInputChar(setInputText, 'y');
      return;
    }

    // ^C Channel Config
    if (input === 'c' && key.ctrl) {
      if (!activeTalkId || !talkManagerRef.current) {
        setError('No active talk to configure.');
      } else {
        setShowChannelConfig(true);
      }
      cleanInputChar(setInputText, 'c');
      return;
    }

    // ^J Jobs Config
    if (input === 'j' && key.ctrl) {
      if (!activeTalkId || !talkManagerRef.current) {
        setError('No active talk to configure.');
      } else {
        setShowJobsConfig(true);
      }
      cleanInputChar(setInputText, 'j');
      return;
    }

    // ^S Settings
    if (input === 's' && key.ctrl) {
      setSettingsFromTalks(false);
      setSettingsTab('talk');
      setShowSettings(true);
      cleanInputChar(setInputText, 's');
      return;
    }

    // Generic Ctrl+key cleanup
    if (key.ctrl && input.match(/[a-z]/i)) {
      cleanInputChar(setInputText, input);
      return;
    }
  });
}
