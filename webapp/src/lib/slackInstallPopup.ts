type SlackInstallPopupEvent = {
  type: 'clawtalk:slack-workspace-install';
  status: 'success' | 'error';
  teamName?: string | null;
  message?: string | null;
};

export type SlackInstallPopupResult = {
  teamName: string | null;
};

export function launchSlackInstallPopup(
  authorizationUrl: string,
): Promise<SlackInstallPopupResult> {
  const popup = window.open(
    authorizationUrl,
    'clawtalk-slack-install',
    'popup=yes,width=620,height=760,noopener=no,noreferrer=no',
  );

  if (!popup) {
    window.location.assign(authorizationUrl);
    return Promise.resolve({ teamName: null });
  }

  return new Promise<SlackInstallPopupResult>((resolve, reject) => {
    let settled = false;
    let pollId = 0;

    const cleanup = () => {
      if (pollId) {
        window.clearInterval(pollId);
      }
      window.removeEventListener('message', onMessage);
    };

    const finish = (
      result: SlackInstallPopupResult | null,
      error?: Error,
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve(result ?? { teamName: null });
      }
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as SlackInstallPopupEvent | null;
      if (!data || data.type !== 'clawtalk:slack-workspace-install') return;
      if (data.status === 'error') {
        finish(
          null,
          new Error(data.message || 'Slack install did not complete.'),
        );
        return;
      }
      finish({ teamName: data.teamName ?? null });
    };

    window.addEventListener('message', onMessage);
    pollId = window.setInterval(() => {
      if (!popup.closed) return;
      finish(null, new Error('Slack install was closed before it completed.'));
    }, 500);
  });
}
