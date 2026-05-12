import type { GooglePickerSession } from './api';

export type GoogleDrivePickerMode = 'folder' | 'file';

export type GoogleDrivePickerSelection = {
  externalId: string;
  displayName: string;
  kind: 'google_drive_folder' | 'google_drive_file';
  metadata: {
    mimeType: string | null;
    url: string | null;
  };
};

type PickerDocument = {
  id?: string;
  name?: string;
  mimeType?: string;
  url?: string;
};

type PickerCallbackData = {
  action?: string;
  docs?: PickerDocument[];
};

type PickerBuilderInstance = {
  addView: (view: unknown) => PickerBuilderInstance;
  setOAuthToken: (token: string) => PickerBuilderInstance;
  setDeveloperKey: (key: string) => PickerBuilderInstance;
  setAppId: (appId: string) => PickerBuilderInstance;
  setOrigin: (origin: string) => PickerBuilderInstance;
  setCallback: (
    callback: (data: PickerCallbackData) => void,
  ) => PickerBuilderInstance;
  setTitle: (title: string) => PickerBuilderInstance;
  enableFeature: (feature: string) => PickerBuilderInstance;
  build: () => { setVisible: (visible: boolean) => void };
};

declare global {
  interface Window {
    gapi?: {
      load: (library: string, callback: () => void) => void;
    };
    google?: {
      picker?: {
        Action: {
          PICKED: string;
          CANCEL: string;
        };
        DocsView: new (viewId?: string) => {
          setIncludeFolders: (enabled: boolean) => unknown;
          setSelectFolderEnabled: (enabled: boolean) => unknown;
          setParent: (folderId: string) => unknown;
          setMimeTypes: (mimeTypes: string) => unknown;
          setMode: (mode: string) => unknown;
        };
        PickerBuilder: new () => PickerBuilderInstance;
        ViewId: {
          DOCS: string;
          FOLDERS: string;
          DOCS_IMAGES_AND_VIDEOS: string;
        };
        Feature: {
          MULTISELECT_ENABLED: string;
        };
      };
    };
  }
}

let pickerScriptPromise: Promise<void> | null = null;

function loadPickerScript(): Promise<void> {
  if (window.gapi?.load && window.google?.picker) {
    return Promise.resolve();
  }
  if (pickerScriptPromise) return pickerScriptPromise;

  pickerScriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-google-picker-script="true"]',
    );
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener(
        'error',
        () => reject(new Error('Failed to load Google Picker script.')),
        { once: true },
      );
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js';
    script.async = true;
    script.defer = true;
    script.dataset.googlePickerScript = 'true';
    script.addEventListener('load', () => resolve(), { once: true });
    script.addEventListener(
      'error',
      () => reject(new Error('Failed to load Google Picker script.')),
      { once: true },
    );
    document.head.appendChild(script);
  });

  return pickerScriptPromise;
}

async function ensurePickerLoaded(): Promise<void> {
  await loadPickerScript();
  if (window.google?.picker && window.gapi?.load) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    if (!window.gapi?.load) {
      reject(new Error('Google Picker API did not initialize.'));
      return;
    }
    window.gapi.load('picker', () => {
      if (!window.google?.picker) {
        reject(new Error('Google Picker API did not initialize.'));
        return;
      }
      resolve();
    });
  });
}

export async function openGoogleDrivePicker(input: {
  session: GooglePickerSession;
  mode: GoogleDrivePickerMode;
}): Promise<GoogleDrivePickerSelection[]> {
  await ensurePickerLoaded();
  const pickerApi = window.google?.picker;
  if (!pickerApi) {
    throw new Error('Google Picker API did not initialize.');
  }

  const view =
    input.mode === 'folder'
      ? new pickerApi.DocsView(pickerApi.ViewId.FOLDERS)
      : new pickerApi.DocsView(pickerApi.ViewId.DOCS);
  view.setIncludeFolders(true);
  view.setParent('root');
  if (input.mode === 'folder') {
    view.setSelectFolderEnabled(true);
  }

  const pickerTitle =
    input.mode === 'folder'
      ? 'Select a Google Drive folder'
      : 'Select a file from Google Drive';

  return new Promise<GoogleDrivePickerSelection[]>((resolve, reject) => {
    const picker = new pickerApi.PickerBuilder()
      .addView(view)
      .setTitle(pickerTitle)
      .setOAuthToken(input.session.oauthToken)
      .setDeveloperKey(input.session.developerKey)
      .setAppId(input.session.appId)
      .setOrigin(window.location.origin)
      .enableFeature(pickerApi.Feature.MULTISELECT_ENABLED)
      .setCallback((data: PickerCallbackData) => {
        if (data.action === pickerApi.Action.CANCEL) {
          resolve([]);
          return;
        }
        if (data.action !== pickerApi.Action.PICKED) {
          return;
        }

        const selections = (data.docs || [])
          .map((doc) => {
            const externalId = doc.id?.trim() || '';
            if (!externalId) return null;
            return {
              externalId,
              displayName: doc.name?.trim() || externalId,
              kind:
                input.mode === 'folder'
                  ? 'google_drive_folder'
                  : 'google_drive_file',
              metadata: {
                mimeType: doc.mimeType ?? null,
                url: doc.url ?? null,
              },
            } satisfies GoogleDrivePickerSelection;
          })
          .filter(
            (selection): selection is GoogleDrivePickerSelection =>
              selection !== null,
          );
        resolve(selections);
      })
      .build();

    try {
      picker.setVisible(true);
    } catch (error) {
      reject(
        error instanceof Error
          ? error
          : new Error('Failed to open Google Picker.'),
      );
    }
  });
}
