export type TalkTerminalListener = (talkId: string) => void;

export class TalkLifecycleWakeBus {
  private readonly listeners = new Set<TalkTerminalListener>();

  subscribeTalkTerminal(listener: TalkTerminalListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  notifyTalkTerminal(talkId: string): void {
    for (const listener of this.listeners) {
      listener(talkId);
    }
  }
}
