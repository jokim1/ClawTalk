type SlackInstallPopupEvent = {
  type: 'clawrocket:slack-workspace-install';
  status: 'success' | 'error';
  message?: string | null;
  workspaceName?: string | null;
};

export function launchSlackInstallPopup(
  authorizationUrl: string,
): Promise<void> {
  const popup = window.open(
    authorizationUrl,
    'clawrocket-slack-install',
    'popup=yes,width=720,height=820,noopener=no,noreferrer=no',
  );

  if (!popup) {
    window.location.assign(authorizationUrl);
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let pollId = 0;

    const cleanup = () => {
      if (pollId) {
        window.clearInterval(pollId);
      }
      window.removeEventListener('message', onMessage);
    };

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as SlackInstallPopupEvent | null;
      if (!data || data.type !== 'clawrocket:slack-workspace-install') return;
      if (data.status === 'error') {
        finish(new Error(data.message || 'Slack installation did not complete.'));
        return;
      }
      finish();
    };

    window.addEventListener('message', onMessage);
    pollId = window.setInterval(() => {
      if (!popup.closed) return;
      finish(new Error('Slack installation was closed before it completed.'));
    }, 500);
  });
}
