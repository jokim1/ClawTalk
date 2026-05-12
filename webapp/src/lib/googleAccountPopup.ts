type GoogleAccountPopupEvent = {
  type: 'clawrocket:google-account-link';
  status: 'success' | 'error';
  message?: string | null;
};

export function launchGoogleAccountPopup(
  authorizationUrl: string,
): Promise<void> {
  const popup = window.open(
    authorizationUrl,
    'clawrocket-google-account',
    'popup=yes,width=620,height=760,noopener=no,noreferrer=no',
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
      const data = event.data as GoogleAccountPopupEvent | null;
      if (!data || data.type !== 'clawrocket:google-account-link') return;
      if (data.status === 'error') {
        finish(
          new Error(data.message || 'Google authorization did not complete.'),
        );
        return;
      }
      finish();
    };

    window.addEventListener('message', onMessage);
    pollId = window.setInterval(() => {
      if (!popup.closed) return;
      finish(new Error('Google authorization was closed before it completed.'));
    }, 500);
  });
}
