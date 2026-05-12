import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  BrowserConnectionMode,
  ChromeSubprofileCandidate,
  ChromeSubprofileDiscovery,
  ChromeUserDataDirectoryDiscovery,
  BrowserProfileSummary,
  createBrowserProfile,
  deleteBrowserProfile,
  discoverChromeSubprofiles,
  discoverChromeUserDataDirectories,
  ExecutorSettings,
  ExecutorSubscriptionHostStatus,
  ExecutorStatus,
  getExecutorSettings,
  getExecutorSubscriptionHostStatus,
  getExecutorStatus,
  getHealthStatus,
  importExecutorSubscriptionFromHost,
  listBrowserProfiles,
  releaseBrowserProfileSessions,
  restartService,
  UnauthorizedError,
  updateBrowserProfileConnectionMode,
  updateExecutorSettings,
  verifyExecutorCredentials,
} from '../lib/api';
type AliasRow = {
  id: string;
  alias: string;
  model: string;
};

type Props = {
  onUnauthorized: () => void;
  userRole: string;
};

type AuthMode = ExecutorSettings['executorAuthMode'];
type BrowserProfileNotice = {
  tone: 'success' | 'error';
  message: string;
};

function formatChromeSubprofileLabel(
  candidate: ChromeSubprofileCandidate,
): string {
  const parts = [candidate.displayName];
  if (candidate.email) {
    parts.push(candidate.email);
  }
  if (candidate.directoryName !== candidate.displayName) {
    parts.push(candidate.directoryName);
  }
  if (candidate.lastUsed) {
    parts.push('Last used');
  }
  return parts.join(' · ');
}

function normalizeBrowserProfileLookupValue(
  value: string | null | undefined,
): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
}

function formatBrowserConnectionMode(mode: BrowserConnectionMode): string {
  switch (mode) {
    case 'managed':
      return 'Managed';
    case 'chrome_profile':
      return 'Chrome Profile';
    case 'cdp':
      return 'CDP';
  }
}

function formatBrowserProfileLabel(profile: BrowserProfileSummary): string {
  return profile.accountLabel
    ? `${profile.siteKey} (${profile.accountLabel})`
    : profile.siteKey;
}

function formatBrowserProfileSessionState(
  state: BrowserProfileSummary['currentSessionState'],
): string | null {
  switch (state) {
    case 'active':
      return 'In Use';
    case 'blocked':
      return 'Blocked';
    case 'takeover':
      return 'Takeover';
    default:
      return null;
  }
}

function formatLastUsedAt(value: string | null): string {
  if (!value) {
    return 'Never used';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    return value;
  }
  return parsed.toLocaleString();
}

function createRowId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === 'function') {
    return randomUUID.call(globalThis.crypto);
  }
  return `alias-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function configuredAliasRows(aliasMap: Record<string, string>): AliasRow[] {
  return Object.entries(aliasMap).map(([alias, model]) => ({
    id: createRowId(),
    alias,
    model,
  }));
}

function formatDateTime(value: string | null): string {
  if (!value) return 'Never configured';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return value;
  return parsed.toLocaleString();
}

function formatAuthMode(mode: AuthMode): string {
  switch (mode) {
    case 'subscription':
      return 'Subscription (Claude Pro/Max)';
    case 'api_key':
      return 'API Key (Anthropic Console)';
    case 'advanced_bearer':
      return 'Advanced bearer / gateway';
    default:
      return 'None';
  }
}

function formatVerificationStatus(
  status: ExecutorStatus['verificationStatus'],
): string {
  switch (status) {
    case 'missing':
      return 'Missing';
    case 'not_verified':
      return 'Not verified';
    case 'verifying':
      return 'Verifying…';
    case 'verified':
      return 'Valid';
    case 'invalid':
      return 'Invalid';
    case 'unavailable':
      return 'Unavailable';
    case 'rate_limited':
      return 'Rate limited';
    default:
      return status;
  }
}

function formatContainerRuntimeAvailability(
  availability: ExecutorStatus['containerRuntimeAvailability'],
): string {
  return availability === 'ready' ? 'Ready' : 'Unavailable';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeAliasDraft(rows: AliasRow[]): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const row of rows) {
    const alias = row.alias.trim();
    const model = row.model.trim();
    if (!alias && !model) continue;
    if (!alias || !model) {
      throw new Error('Each alias row must include both an alias and a model.');
    }
    if (normalized[alias]) {
      throw new Error(`Duplicate alias "${alias}" is not allowed.`);
    }
    normalized[alias] = model;
  }

  return normalized;
}

function standbyCredentials(settings: ExecutorSettings): string[] {
  const items: string[] = [];
  if (settings.hasOauthToken && settings.executorAuthMode !== 'subscription') {
    items.push('Subscription login configured');
  }
  if (settings.hasApiKey && settings.executorAuthMode !== 'api_key') {
    items.push('API Key configured');
  }
  if (
    settings.hasAuthToken &&
    settings.executorAuthMode !== 'advanced_bearer'
  ) {
    items.push('Advanced bearer configured');
  }
  return items;
}

function fieldDraftState(input: {
  stored: boolean;
  cleared: boolean;
  draftValue: string;
}): {
  hasCredential: boolean;
  message: string;
} {
  if (input.cleared) {
    return {
      hasCredential: false,
      message: 'This credential will be cleared when you save.',
    };
  }
  if (input.draftValue.trim()) {
    return {
      hasCredential: true,
      message:
        'A new credential is entered locally and will be saved when you click Save Credential Settings.',
    };
  }
  if (input.stored) {
    return {
      hasCredential: true,
      message: 'A credential is already stored in settings.',
    };
  }
  return {
    hasCredential: false,
    message: 'No credential is currently stored.',
  };
}

function activeExecutorCredentialHint(
  settings: ExecutorSettings,
  mode: ExecutorStatus['executorAuthMode'],
): string | null {
  switch (mode) {
    case 'subscription':
      return settings.oauthTokenHint || settings.authTokenHint;
    case 'api_key':
      return settings.apiKeyHint;
    case 'advanced_bearer':
      return settings.authTokenHint;
    default:
      return null;
  }
}

function activeExecutorCredentialSource(
  settings: ExecutorSettings,
  mode: ExecutorStatus['executorAuthMode'],
): 'stored' | 'env' | null {
  switch (mode) {
    case 'subscription':
      return settings.oauthTokenSource || settings.authTokenSource;
    case 'api_key':
      return settings.apiKeySource;
    case 'advanced_bearer':
      return settings.authTokenSource;
    default:
      return null;
  }
}

export function SettingsPage({ onUnauthorized, userRole }: Props) {
  const [settings, setSettings] = useState<ExecutorSettings | null>(null);
  const [status, setStatus] = useState<ExecutorStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busySection, setBusySection] = useState<
    'credentials' | 'verification' | 'aliases' | 'restart' | null
  >(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [authModeDraft, setAuthModeDraft] = useState<AuthMode>('none');
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [oauthDraft, setOauthDraft] = useState('');
  const [authTokenDraft, setAuthTokenDraft] = useState('');
  const [baseUrlDraft, setBaseUrlDraft] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [clearOauth, setClearOauth] = useState(false);
  const [clearAuthToken, setClearAuthToken] = useState(false);
  const [clearBaseUrl, setClearBaseUrl] = useState(false);
  const [aliasRows, setAliasRows] = useState<AliasRow[]>([]);
  const [subscriptionHostStatus, setSubscriptionHostStatus] =
    useState<ExecutorSubscriptionHostStatus | null>(null);
  const [subscriptionHostBusy, setSubscriptionHostBusy] = useState<
    'checking' | 'importing' | null
  >(null);
  const [showSubscriptionAdvanced, setShowSubscriptionAdvanced] =
    useState(false);
  const verificationPollAttemptsRef = useRef(0);

  // Browser profiles state
  const [browserProfiles, setBrowserProfiles] = useState<BrowserProfileSummary[]>([]);
  const [browserProfilesBusy, setBrowserProfilesBusy] = useState(false);
  const [browserProfileEditId, setBrowserProfileEditId] = useState<string | null>(null);
  const [browserProfileEditMode, setBrowserProfileEditMode] = useState<BrowserConnectionMode>('managed');
  const [browserProfileEditConfig, setBrowserProfileEditConfig] = useState('');
  const [browserProfileEditProfileDirectory, setBrowserProfileEditProfileDirectory] =
    useState('');
  const [browserProfileNotice, setBrowserProfileNotice] =
    useState<BrowserProfileNotice | null>(null);
  const [showAddProfile, setShowAddProfile] = useState(false);
  const [newProfileSiteKey, setNewProfileSiteKey] = useState('');
  const [newProfileAccountLabel, setNewProfileAccountLabel] = useState('');
  const [newProfileMode, setNewProfileMode] = useState<BrowserConnectionMode>('managed');
  const [newProfileConfig, setNewProfileConfig] = useState('');
  const [newProfileProfileDirectory, setNewProfileProfileDirectory] = useState('');
  const [chromeUserDataDiscovery, setChromeUserDataDiscovery] =
    useState<ChromeUserDataDirectoryDiscovery | null>(null);
  const [chromeUserDataDiscoveryBusy, setChromeUserDataDiscoveryBusy] =
    useState(false);
  const [chromeUserDataDiscoveryError, setChromeUserDataDiscoveryError] =
    useState<string | null>(null);
  const [chromeSubprofileDiscovery, setChromeSubprofileDiscovery] =
    useState<ChromeSubprofileDiscovery | null>(null);
  const [chromeSubprofileDiscoveryPath, setChromeSubprofileDiscoveryPath] =
    useState<string | null>(null);
  const [chromeSubprofileDiscoveryBusy, setChromeSubprofileDiscoveryBusy] =
    useState(false);
  const [chromeSubprofileDiscoveryError, setChromeSubprofileDiscoveryError] =
    useState<string | null>(null);

  const applySettingsDrafts = (nextSettings: ExecutorSettings): void => {
    setSettings(nextSettings);
    setAliasRows(configuredAliasRows(nextSettings.configuredAliasMap));
    setAuthModeDraft(nextSettings.executorAuthMode);
    setBaseUrlDraft(nextSettings.anthropicBaseUrl || '');
    setApiKeyDraft('');
    setOauthDraft('');
    setAuthTokenDraft('');
    setClearApiKey(false);
    setClearOauth(false);
    setClearAuthToken(false);
    setClearBaseUrl(false);
  };

  const loadBrowserProfiles = async (): Promise<void> => {
    try {
      const profiles = await listBrowserProfiles();
      setBrowserProfiles(profiles);
    } catch {
      // Non-critical — don't block the page for browser profile load failures
    }
  };

  const loadChromeUserDataDiscovery = async (
    force = false,
  ): Promise<ChromeUserDataDirectoryDiscovery | null> => {
    if (!force && chromeUserDataDiscovery) {
      return chromeUserDataDiscovery;
    }

    setChromeUserDataDiscoveryBusy(true);
    setChromeUserDataDiscoveryError(null);
    try {
      const discovery = await discoverChromeUserDataDirectories();
      setChromeUserDataDiscovery(discovery);
      return discovery;
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return null;
      }
      setChromeUserDataDiscoveryError(
        err instanceof ApiError
          ? err.message
          : 'Failed to detect Chrome user data directories.',
      );
      return null;
    } finally {
      setChromeUserDataDiscoveryBusy(false);
    }
  };

  const loadChromeSubprofileDiscovery = async (
    userDataDir: string,
    force = false,
  ): Promise<ChromeSubprofileDiscovery | null> => {
    const trimmed = userDataDir.trim();
    if (!trimmed) {
      setChromeSubprofileDiscovery(null);
      setChromeSubprofileDiscoveryPath(null);
      setChromeSubprofileDiscoveryError(null);
      return null;
    }

    if (
      !force &&
      chromeSubprofileDiscovery &&
      chromeSubprofileDiscoveryPath === trimmed
    ) {
      return chromeSubprofileDiscovery;
    }

    setChromeSubprofileDiscoveryBusy(true);
    setChromeSubprofileDiscoveryError(null);
    try {
      const discovery = await discoverChromeSubprofiles(trimmed);
      setChromeSubprofileDiscovery(discovery);
      setChromeSubprofileDiscoveryPath(trimmed);
      return discovery;
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return null;
      }
      setChromeSubprofileDiscovery(null);
      setChromeSubprofileDiscoveryPath(trimmed);
      setChromeSubprofileDiscoveryError(
        err instanceof ApiError
          ? err.message
          : 'Failed to detect Chrome subprofiles.',
      );
      return null;
    } finally {
      setChromeSubprofileDiscoveryBusy(false);
    }
  };

  const maybeAutofillChromeProfileSelection = async (input: {
    currentPath: string;
    currentProfileDirectory: string;
    setPath: (value: string) => void;
    setProfileDirectory: (value: string) => void;
  }): Promise<void> => {
    let nextPath = input.currentPath.trim();
    if (!nextPath) {
      const discovery = await loadChromeUserDataDiscovery();
      if (!discovery) {
        return;
      }
      const preferredPath =
        discovery.candidates.find((candidate) => candidate.preferred) ||
        discovery.candidates[0];
      if (!preferredPath) {
        return;
      }
      nextPath = preferredPath.path;
      input.setPath(nextPath);
    }

    const subprofileDiscovery = await loadChromeSubprofileDiscovery(nextPath);
    if (!subprofileDiscovery || input.currentProfileDirectory.trim()) {
      return;
    }

    const preferredProfile =
      subprofileDiscovery.candidates.find((candidate) => candidate.preferred) ||
      subprofileDiscovery.candidates[0];
    if (preferredProfile) {
      input.setProfileDirectory(preferredProfile.directoryName);
    }
  };

  const loadPage = async (): Promise<void> => {
    try {
      const [nextSettings, nextStatus] = await Promise.all([
        getExecutorSettings(),
        getExecutorStatus(),
      ]);
      applySettingsDrafts(nextSettings);
      setStatus(nextStatus);
      setPageError(null);
      void loadBrowserProfiles();
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setPageError(
        err instanceof ApiError ? err.message : 'Failed to load settings.',
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadPage();
  }, []);

  useEffect(() => {
    if (status?.verificationStatus !== 'verifying') {
      verificationPollAttemptsRef.current = 0;
      return;
    }

    let cancelled = false;
    let timer: number | null = null;

    const scheduleNextPoll = (): void => {
      const attempt = verificationPollAttemptsRef.current;
      const delayMs = attempt < 5 ? 2_000 : attempt < 15 ? 5_000 : 10_000;
      timer = window.setTimeout(() => {
        void getExecutorStatus()
          .then((nextStatus) => {
            if (cancelled) return;
            verificationPollAttemptsRef.current += 1;
            setStatus(nextStatus);
            if (nextStatus.verificationStatus === 'verifying') {
              scheduleNextPoll();
            }
          })
          .catch((err) => {
            if (cancelled) return;
            if (err instanceof UnauthorizedError) {
              onUnauthorized();
              return;
            }
            setPageError(
              err instanceof ApiError
                ? err.message
                : 'Failed to refresh verification status.',
            );
          });
      }, delayMs);
    };

    scheduleNextPoll();

    return () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [status?.verificationStatus, onUnauthorized]);

  const configErrors = useMemo(() => {
    const combined = new Set<string>();
    for (const error of settings?.configErrors || []) combined.add(error);
    for (const error of status?.configErrors || []) combined.add(error);
    return Array.from(combined);
  }, [settings, status]);

  const matchingNewBrowserProfile =
    normalizeBrowserProfileLookupValue(newProfileSiteKey) !== null
      ? browserProfiles.find((profile) => {
          const normalizedSiteKey = normalizeBrowserProfileLookupValue(
            profile.siteKey,
          );
          const normalizedAccountLabel = normalizeBrowserProfileLookupValue(
            profile.accountLabel,
          );
          return (
            normalizedSiteKey ===
              normalizeBrowserProfileLookupValue(newProfileSiteKey) &&
            normalizedAccountLabel ===
              normalizeBrowserProfileLookupValue(newProfileAccountLabel)
          );
        }) || null
      : null;

  const editingBrowserProfile = browserProfileEditId
    ? browserProfiles.find((profile) => profile.id === browserProfileEditId) || null
    : null;


  const handleApiFailure = (err: unknown, fallback: string): void => {
    if (err instanceof UnauthorizedError) {
      onUnauthorized();
      return;
    }
    setPageError(err instanceof ApiError ? err.message : fallback);
  };

  const saveCredentials = async (): Promise<void> => {
    if (!settings) return;

    setBusySection('credentials');
    setPageError(null);
    setNotice(null);

    try {
      const update: Record<string, string | null> = {
        executorAuthMode: authModeDraft,
      };

      if (clearOauth) {
        update.claudeOauthToken = null;
      } else if (authModeDraft === 'subscription') {
        if (oauthDraft.trim()) {
          update.claudeOauthToken = oauthDraft.trim();
        }
      }

      if (clearApiKey) {
        update.anthropicApiKey = null;
      } else if (authModeDraft === 'api_key') {
        if (apiKeyDraft.trim()) {
          update.anthropicApiKey = apiKeyDraft.trim();
        }
      }

      if (clearAuthToken) {
        update.anthropicAuthToken = null;
      } else if (authModeDraft === 'advanced_bearer') {
        if (authTokenDraft.trim()) {
          update.anthropicAuthToken = authTokenDraft.trim();
        }
      }

      if (clearBaseUrl) {
        update.anthropicBaseUrl = null;
      } else if (
        (authModeDraft === 'api_key' || authModeDraft === 'advanced_bearer') &&
        baseUrlDraft.trim() !== (settings.anthropicBaseUrl || '')
      ) {
        update.anthropicBaseUrl = baseUrlDraft.trim();
      }

      const nextSettings = await updateExecutorSettings(update);
      applySettingsDrafts(nextSettings);
      const nextStatus = await getExecutorStatus();
      setStatus(nextStatus);

      if (
        nextSettings.executorAuthMode === 'api_key' ||
        nextSettings.executorAuthMode === 'advanced_bearer'
      ) {
        setNotice(
          nextStatus.verificationStatus === 'verifying'
            ? 'Credentials saved. Verification is running in the background.'
            : 'Credentials saved. Use Re-verify if you want to validate the active credential now.',
        );
      } else if (nextSettings.executorAuthMode === 'subscription') {
        setNotice(
          'Subscription mode is now active. Use Check host Claude login for guided setup, or Verify subscription runtime to confirm the current environment can execute with the selected subscription credential.',
        );
      } else {
        setNotice(
          'Credentials saved. Core executor runs will remain unavailable until an active Anthropic auth mode is configured.',
        );
      }
    } catch (err) {
      handleApiFailure(err, 'Failed to save credentials.');
    } finally {
      setBusySection(null);
    }
  };

  const handleVerify = async (): Promise<void> => {
    setBusySection('verification');
    setPageError(null);
    setNotice(null);

    try {
      const result = await verifyExecutorCredentials();
      const nextStatus = await getExecutorStatus();
      setStatus(nextStatus);
      setNotice(result.message);
    } catch (err) {
      handleApiFailure(err, 'Failed to start verification.');
    } finally {
      setBusySection(null);
    }
  };

  const checkSubscriptionHostLogin = async (): Promise<void> => {
    setSubscriptionHostBusy('checking');
    setPageError(null);
    setNotice(null);

    try {
      const nextHostStatus = await getExecutorSubscriptionHostStatus();
      setSubscriptionHostStatus(nextHostStatus);
      if (
        !nextHostStatus.importAvailable &&
        !nextHostStatus.serviceEnvOauthPresent &&
        (!nextHostStatus.claudeCliInstalled || nextHostStatus.hostLoginDetected)
      ) {
        setShowSubscriptionAdvanced(true);
      }
      setNotice(nextHostStatus.message);
    } catch (err) {
      handleApiFailure(err, 'Failed to check Claude host login.');
    } finally {
      setSubscriptionHostBusy(null);
    }
  };

  const importSubscriptionFromHost = async (): Promise<void> => {
    if (!subscriptionHostStatus?.hostCredentialFingerprint) return;

    setSubscriptionHostBusy('importing');
    setPageError(null);
    setNotice(null);

    try {
      const result = await importExecutorSubscriptionFromHost(
        subscriptionHostStatus.hostCredentialFingerprint,
      );
      applySettingsDrafts(result.settings);
      const verifyResult = await verifyExecutorCredentials();
      const nextStatus = await getExecutorStatus();
      setStatus(nextStatus);
      const latestHostStatus = await getExecutorSubscriptionHostStatus();
      setSubscriptionHostStatus(latestHostStatus);
      setNotice(
        verifyResult.message ||
          (result.status === 'no_change'
            ? 'The host subscription credential is already imported into settings.'
            : 'Subscription credential imported from the service host.'),
      );
    } catch (err) {
      handleApiFailure(err, 'Failed to import subscription credential from host.');
      if (err instanceof ApiError && err.code === 'host_state_changed') {
        try {
          const latestHostStatus = await getExecutorSubscriptionHostStatus();
          setSubscriptionHostStatus(latestHostStatus);
        } catch {
          // Ignore refresh failures after the primary error.
        }
      }
    } finally {
      setSubscriptionHostBusy(null);
    }
  };

  const saveAliasMap = async (): Promise<void> => {
    setBusySection('aliases');
    setPageError(null);
    setNotice(null);

    try {
      const aliasModelMap = normalizeAliasDraft(aliasRows);

      const nextSettings = await updateExecutorSettings({
        aliasModelMap,
      });
      applySettingsDrafts(nextSettings);
      const nextStatus = await getExecutorStatus();
      setStatus(nextStatus);
      setNotice(
        'Alias settings saved. Restart required for constructor-captured changes.',
      );
    } catch (err) {
      handleApiFailure(err, 'Failed to save alias settings.');
    } finally {
      setBusySection(null);
    }
  };

  const handleRestart = async (): Promise<void> => {
    if (!status) return;
    if (
      !window.confirm(
        'This will restart the ClawRocket service. Active connections will be interrupted. Continue?',
      )
    ) {
      return;
    }

    setBusySection('restart');
    setPageError(null);
    setNotice(null);

    try {
      const previousBootId = status.bootId;
      await restartService();

      const deadline = Date.now() + 30_000;
      await sleep(2_000);

      while (Date.now() < deadline) {
        const healthy = await getHealthStatus();
        if (healthy) {
          try {
            const nextStatus = await getExecutorStatus();
            if (
              nextStatus.bootId !== previousBootId &&
              nextStatus.pendingRestartReasons.length === 0
            ) {
              setStatus(nextStatus);
              await loadPage();
              setNotice('Service restarted successfully.');
              return;
            }
          } catch {
            // Retry until the service is fully back.
          }
        }

        await sleep(2_000);
      }

      throw new Error('Timed out waiting for the service to restart.');
    } catch (err) {
      handleApiFailure(err, 'Failed to restart the service.');
    } finally {
      setBusySection(null);
    }
  };

  if (loading) {
    return <section className="page-state">Loading settings…</section>;
  }

  if (!settings || !status) {
    return <section className="page-state">Settings are unavailable.</section>;
  }

  const standby = standbyCredentials(settings);
  const showBaseUrl =
    authModeDraft === 'api_key' || authModeDraft === 'advanced_bearer';
  const verifyButtonLabel =
    authModeDraft === 'subscription'
      ? 'Verify subscription runtime'
      : 'Verify API key';
  const showSubscriptionImportButton = Boolean(
    subscriptionHostStatus?.importAvailable &&
      subscriptionHostStatus.hostCredentialFingerprint,
  );
  const selectedModeCredentialState =
    authModeDraft === 'subscription'
      ? fieldDraftState({
          stored: settings.hasOauthToken || settings.hasAuthToken,
          cleared: clearOauth,
          draftValue: oauthDraft,
        })
      : authModeDraft === 'api_key'
        ? fieldDraftState({
            stored: settings.hasApiKey,
            cleared: clearApiKey,
            draftValue: apiKeyDraft,
          })
        : authModeDraft === 'advanced_bearer'
          ? fieldDraftState({
              stored: settings.hasAuthToken,
              cleared: clearAuthToken,
              draftValue: authTokenDraft,
            })
          : {
              hasCredential: false,
              message:
                'No active Anthropic auth mode is selected. Stored credentials remain on standby until you choose a mode and save.',
            };
  const hasUnsavedModeChange = authModeDraft !== settings.executorAuthMode;
  const hasUnsavedSelectedModeCredentialChange =
    authModeDraft === 'subscription'
      ? clearOauth || oauthDraft.trim().length > 0
      : authModeDraft === 'api_key'
        ? clearApiKey ||
          apiKeyDraft.trim().length > 0 ||
          clearBaseUrl ||
          baseUrlDraft.trim() !== (settings.anthropicBaseUrl || '')
        : authModeDraft === 'advanced_bearer'
          ? clearAuthToken ||
            authTokenDraft.trim().length > 0 ||
            clearBaseUrl ||
            baseUrlDraft.trim() !== (settings.anthropicBaseUrl || '')
          : false;
  const hasPendingCredentialState =
    hasUnsavedModeChange || hasUnsavedSelectedModeCredentialChange;
  const displayedConfiguredLabel =
    authModeDraft === 'none'
      ? 'No'
      : hasPendingCredentialState
        ? selectedModeCredentialState.hasCredential
          ? 'Ready to save'
          : 'Missing'
        : status.activeCredentialConfigured
          ? 'Configured'
          : 'Missing';
  const displayedVerificationLabel =
    authModeDraft === 'none'
      ? 'Select a mode'
      : hasPendingCredentialState
        ? 'Unsaved changes'
        : formatVerificationStatus(status.verificationStatus);
  const displayedLastVerifiedLabel =
    authModeDraft === 'none'
      ? 'No active mode selected'
      : hasPendingCredentialState
        ? 'Will refresh after save'
        : formatDateTime(status.lastVerifiedAt);
  const activeCredentialHint = activeExecutorCredentialHint(
    settings,
    status.executorAuthMode,
  );
  const activeCredentialSource = activeExecutorCredentialSource(
    settings,
    status.executorAuthMode,
  );
  const configStatusLabel = status.activeCredentialConfigured
    ? activeCredentialSource === 'env'
      ? 'Environment-managed'
      : 'Owned by settings page'
    : settings.isConfigured
      ? 'Owned by settings page'
      : 'Using bootstrap defaults';
  const showStoredVerificationNote =
    !!status.lastVerificationError &&
    (status.verificationStatus === 'invalid' ||
      status.verificationStatus === 'rate_limited' ||
      status.verificationStatus === 'unavailable');
  const showSubscriptionRuntimeWarning =
    status.executorAuthMode === 'subscription' &&
    status.activeCredentialConfigured &&
    status.containerRuntimeAvailability === 'unavailable';

  const applyChromeUserDataDirectorySelection = async (input: {
    path: string;
    currentProfileDirectory: string;
    setPath: (value: string) => void;
    setProfileDirectory: (value: string) => void;
  }): Promise<void> => {
    input.setPath(input.path);
    if (input.currentProfileDirectory.trim()) {
      return;
    }
    const discovery = await loadChromeSubprofileDiscovery(input.path, true);
    const preferred =
      discovery?.candidates.find((candidate) => candidate.preferred) ||
      discovery?.candidates[0];
    if (preferred) {
      input.setProfileDirectory(preferred.directoryName);
    }
  };

  const renderChromeProfileSelection = (input: {
    currentPath: string;
    setPath: (value: string) => void;
    currentProfileDirectory: string;
    setProfileDirectory: (value: string) => void;
  }): JSX.Element => {
    const userDataCandidates = chromeUserDataDiscovery?.candidates || [];
    const userDataDetectLabel = chromeUserDataDiscoveryBusy
      ? 'Detecting…'
      : userDataCandidates.length > 0
        ? 'Refresh detected paths'
        : 'Detect Chrome paths';
    const activeSubprofileDiscovery =
      chromeSubprofileDiscoveryPath === input.currentPath.trim()
        ? chromeSubprofileDiscovery
        : null;
    const subprofileCandidates = activeSubprofileDiscovery?.candidates || [];
    const selectedSubprofile =
      subprofileCandidates.find(
        (candidate) => candidate.directoryName === input.currentProfileDirectory,
      ) || null;
    const subprofileDetectLabel = chromeSubprofileDiscoveryBusy
      ? 'Detecting subprofiles…'
      : subprofileCandidates.length > 0
        ? 'Refresh subprofiles'
        : 'Detect subprofiles';

    return (
      <div
        style={{
          marginLeft: '1.5rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem',
        }}
      >
        <input
          type="text"
          placeholder="/home/user/.config/google-chrome"
          value={input.currentPath}
          onChange={(e) => {
            input.setPath(e.target.value);
            input.setProfileDirectory('');
          }}
          onBlur={(e) => {
            if (e.target.value.trim()) {
              void loadChromeSubprofileDiscovery(e.target.value.trim(), true);
            }
          }}
          style={{ marginLeft: '1.5rem' }}
        />
        <div style={{ fontSize: '0.9rem', opacity: 0.75 }}>
          Use the Chrome user data directory, not a profile subdirectory like
          <code style={{ marginLeft: '0.25rem' }}>Default</code> or
          <code style={{ marginLeft: '0.25rem' }}>Profile 1</code>.
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
          <button
            type="button"
            className="secondary-btn"
            onClick={() => void loadChromeUserDataDiscovery(true)}
            disabled={chromeUserDataDiscoveryBusy}
          >
            {userDataDetectLabel}
          </button>
          {userDataCandidates.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              className="secondary-btn"
              onClick={() =>
                void applyChromeUserDataDirectorySelection({
                  path: candidate.path,
                  currentProfileDirectory: '',
                  setPath: input.setPath,
                  setProfileDirectory: input.setProfileDirectory,
                })
              }
              disabled={chromeUserDataDiscoveryBusy}
            >
              Use {candidate.label}
            </button>
          ))}
        </div>
        {userDataCandidates.length > 0 ? (
          <div style={{ fontSize: '0.9rem', opacity: 0.75 }}>
            Detected on this machine:{' '}
            {userDataCandidates.map((candidate) => candidate.path).join(' · ')}
          </div>
        ) : chromeUserDataDiscovery?.defaultPathHint ? (
          <div style={{ fontSize: '0.9rem', opacity: 0.75 }}>
            Nothing was auto-detected yet. The usual path on this machine is
            <code style={{ marginLeft: '0.25rem' }}>
              {chromeUserDataDiscovery.defaultPathHint}
            </code>
            .
          </div>
        ) : null}
        {chromeUserDataDiscoveryError ? (
          <div style={{ color: 'var(--danger-color, #b91c1c)', fontSize: '0.9rem' }}>
            {chromeUserDataDiscoveryError}
          </div>
        ) : null}
        {input.currentPath.trim() ? (
          <div style={{ fontSize: '0.9rem', opacity: 0.75 }}>
            Selected path:
            <code style={{ marginLeft: '0.25rem' }}>{input.currentPath}</code>
          </div>
        ) : null}
        <div style={{ marginTop: '0.25rem', fontWeight: 600 }}>
          Chrome subprofile
        </div>
        <div style={{ fontSize: '0.9rem', opacity: 0.75 }}>
          Recommended. This determines which signed-in Chrome profile the agent
          inherits for this site.
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
          <button
            type="button"
            className="secondary-btn"
            onClick={() => void loadChromeSubprofileDiscovery(input.currentPath, true)}
            disabled={chromeSubprofileDiscoveryBusy || !input.currentPath.trim()}
          >
            {subprofileDetectLabel}
          </button>
        </div>
        <select
          value={input.currentProfileDirectory}
          onChange={(e) => input.setProfileDirectory(e.target.value)}
          disabled={!input.currentPath.trim()}
          style={{ marginLeft: '1.5rem', maxWidth: '42rem' }}
        >
          <option value="">Chrome default / last-used profile</option>
          {subprofileCandidates.map((candidate) => (
            <option key={candidate.directoryName} value={candidate.directoryName}>
              {formatChromeSubprofileLabel(candidate)}
            </option>
          ))}
        </select>
        {subprofileCandidates.length > 0 ? (
          <div style={{ fontSize: '0.9rem', opacity: 0.75 }}>
            Detected subprofiles:{' '}
            {subprofileCandidates
              .map((candidate) => formatChromeSubprofileLabel(candidate))
              .join(' · ')}
          </div>
        ) : activeSubprofileDiscovery ? (
          <div style={{ fontSize: '0.9rem', opacity: 0.75 }}>
            No Chrome subprofiles were detected in this user data directory.
          </div>
        ) : null}
        {chromeSubprofileDiscoveryError &&
        chromeSubprofileDiscoveryPath === input.currentPath.trim() ? (
          <div style={{ color: 'var(--danger-color, #b91c1c)', fontSize: '0.9rem' }}>
            {chromeSubprofileDiscoveryError}
          </div>
        ) : null}
        {selectedSubprofile ? (
          <div style={{ fontSize: '0.9rem', opacity: 0.75 }}>
            Selected subprofile:
            <code style={{ marginLeft: '0.25rem' }}>
              {formatChromeSubprofileLabel(selectedSubprofile)}
            </code>
          </div>
        ) : input.currentProfileDirectory.trim() ? (
          <div style={{ fontSize: '0.9rem', opacity: 0.75 }}>
            Selected subprofile:
            <code style={{ marginLeft: '0.25rem' }}>
              {input.currentProfileDirectory}
            </code>
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <section className="page-shell settings-shell">
      <header className="page-header">
        <div>
          <h1>Executor Settings</h1>
          <p>
            Manage Anthropic auth mode, aliases, and restart-required changes
            for the core executor.
          </p>
        </div>
      </header>

      {pageError ? (
        <div className="settings-banner settings-banner-error">{pageError}</div>
      ) : null}
      {notice ? (
        <div className="settings-banner settings-banner-success">{notice}</div>
      ) : null}
      {configErrors.length > 0 ? (
        <div className="settings-banner settings-banner-error">
          <strong>Configuration errors detected.</strong>
          <ul>
            {configErrors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {status.pendingRestartReasons.length > 0 ? (
        <div className="settings-banner settings-banner-warning">
          <strong>Pending changes require restart.</strong>
          <ul>
            {status.pendingRestartReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          {userRole !== 'owner' ? (
            <p>Only the account owner can restart the service.</p>
          ) : null}
        </div>
      ) : null}

      <section className="settings-card">
        <h2>Executor Status</h2>
        <div className="settings-grid">
          <div>
            <span className="settings-label">Mode</span>
            <strong>{status.mode}</strong>
          </div>
          <div>
            <span className="settings-label">Active auth mode</span>
            <strong>{formatAuthMode(status.executorAuthMode)}</strong>
          </div>
          <div>
            <span className="settings-label">Credential</span>
            <strong>
              {status.activeCredentialConfigured ? 'Configured' : 'Missing'}
            </strong>
          </div>
          <div>
            <span className="settings-label">Verification</span>
            <strong>{formatVerificationStatus(status.verificationStatus)}</strong>
          </div>
          <div>
            <span className="settings-label">Container runtime</span>
            <strong>
              {formatContainerRuntimeAvailability(
                status.containerRuntimeAvailability,
              )}
            </strong>
          </div>
          <div>
            <span className="settings-label">Alias map</span>
            <strong>{status.hasValidAliasMap ? 'Valid' : 'Invalid'}</strong>
          </div>
          <div>
            <span className="settings-label">Config status</span>
            <strong>{configStatusLabel}</strong>
          </div>
          <div>
            <span className="settings-label">Active runs</span>
            <strong>{status.activeRunCount}</strong>
          </div>
          <div>
            <span className="settings-label">Last verified</span>
            <strong>{formatDateTime(status.lastVerifiedAt)}</strong>
          </div>
        </div>
        {showSubscriptionRuntimeWarning ? (
          <p className="settings-copy">
            <strong>Runtime note:</strong> Docker / the container runtime is
            currently unavailable, so subscription verification and
            container-backed Claude execution cannot run until it is healthy.
          </p>
        ) : null}
        {showStoredVerificationNote ? (
          <p className="settings-copy">
            <strong>Verification note:</strong> {status.lastVerificationError}
          </p>
        ) : null}
        {status.activeCredentialConfigured && activeCredentialHint ? (
          <p className="settings-copy">
            <strong>Credential source:</strong> {activeCredentialHint}
          </p>
        ) : null}
        {settings.authModeSource === 'inferred' ? (
          <p className="settings-copy">
            <strong>Mode source:</strong> The active Claude auth mode is being
            inferred from currently available runtime credentials.
          </p>
        ) : null}
      </section>

      <section className="settings-card">
        <h2>Model Alias Map</h2>
        <p className="settings-copy">
          Give friendly names to model identifiers. Each row maps a canonical
          model name to a short alias used throughout the app.
        </p>
        <div className="settings-alias-list">
          {aliasRows.map((row) => (
            <div key={row.id} className="settings-alias-row">
              <input
                type="text"
                value={row.model}
                placeholder="Model name (e.g. claude-opus-4-6)"
                className="settings-alias-model"
                onChange={(event) =>
                  setAliasRows((current) =>
                    current.map((item) =>
                      item.id === row.id
                        ? { ...item, model: event.target.value }
                        : item,
                    ),
                  )
                }
              />
              <input
                type="text"
                value={row.alias}
                placeholder="Alias (e.g. Opus)"
                className="settings-alias-name"
                onChange={(event) =>
                  setAliasRows((current) =>
                    current.map((item) =>
                      item.id === row.id
                        ? { ...item, alias: event.target.value }
                        : item,
                    ),
                  )
                }
              />
              <button
                type="button"
                className="secondary-btn"
                onClick={() =>
                  setAliasRows((current) =>
                    current.filter((item) => item.id !== row.id),
                  )
                }
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="secondary-btn"
          onClick={() =>
            setAliasRows((current) => [
              ...current,
              { id: createRowId(), alias: '', model: '' },
            ])
          }
        >
          Add Alias
        </button>

        <button
          type="button"
          className="primary-btn"
          disabled={busySection === 'aliases'}
          onClick={() => void saveAliasMap()}
        >
          {busySection === 'aliases' ? 'Saving…' : 'Save Alias Settings'}
        </button>
      </section>

      <section className="settings-card">
        <h2>Browser Profiles</h2>
        <p className="settings-copy">
          Configure how browser profiles connect: use a managed sandbox, your
          real Chrome profile (inherits cookies/login), or attach to a running
          Chrome instance via CDP.
        </p>
        <p className="settings-copy" style={{ marginTop: '-0.25rem' }}>
          Profiles are matched by exact site key plus account label, so
          <code style={{ margin: '0 0.2rem' }}>linkedin</code>
          and
          <code style={{ margin: '0 0.2rem' }}>linkedin.com</code>
          are different profiles.
        </p>

        {browserProfileNotice ? (
          <div
            className={`settings-banner ${
              browserProfileNotice.tone === 'error'
                ? 'settings-banner-error'
                : 'settings-banner-success'
            }`}
            role={browserProfileNotice.tone === 'error' ? 'alert' : 'status'}
          >
            {browserProfileNotice.message}
          </div>
        ) : null}

        {browserProfiles.length > 0 ? (
          <div className="settings-grid" style={{ gap: '0.75rem' }}>
            {browserProfiles.map((profile) => (
              <div
                key={profile.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.75rem',
                  padding: '0.5rem 0',
                  borderBottom: '1px solid var(--border-color, #e5e5e5)',
                }}
              >
                <div style={{ flex: 1 }}>
                  <strong>{profile.siteKey}</strong>
                  {profile.accountLabel ? (
                    <span style={{ opacity: 0.6 }}> ({profile.accountLabel})</span>
                  ) : null}
                  <span
                    style={{
                      marginLeft: '0.5rem',
                      fontSize: '0.8em',
                      padding: '0.1em 0.4em',
                      borderRadius: '3px',
                      background:
                        profile.connectionMode === 'managed'
                          ? 'var(--badge-bg, #e8e8e8)'
                          : profile.connectionMode === 'chrome_profile'
                            ? 'var(--badge-active-bg, #dbeafe)'
                            : 'var(--badge-warn-bg, #fef3c7)',
                    }}
                  >
                    {profile.connectionMode === 'managed'
                      ? 'Managed'
                      : profile.connectionMode === 'chrome_profile'
                        ? 'Chrome Profile'
                        : 'CDP'}
                  </span>
                  {profile.inUseSessionCount > 0 ? (
                    <span
                      style={{
                        marginLeft: '0.5rem',
                        fontSize: '0.8em',
                        padding: '0.1em 0.4em',
                        borderRadius: '3px',
                        background:
                          profile.currentSessionState === 'blocked'
                            ? 'var(--badge-warn-bg, #fef3c7)'
                            : profile.currentSessionState === 'takeover'
                              ? 'var(--badge-active-bg, #dbeafe)'
                              : 'var(--badge-success-bg, #dcfce7)',
                      }}
                    >
                      {formatBrowserProfileSessionState(
                        profile.currentSessionState,
                      ) || 'In Use'}
                    </span>
                  ) : null}
                  {profile.connectionConfig.mode !== 'managed' ? (
                    <div style={{ marginTop: '0.25rem', fontSize: '0.9rem', opacity: 0.75 }}>
                      {profile.connectionConfig.mode === 'chrome_profile'
                        ? profile.connectionConfig.profileDirectory
                          ? `${profile.connectionConfig.chromeProfilePath} · ${profile.connectionConfig.profileDirectory}`
                          : profile.connectionConfig.chromeProfilePath
                        : profile.connectionConfig.endpointUrl}
                    </div>
                  ) : null}
                  <div style={{ marginTop: '0.25rem', fontSize: '0.9rem', opacity: 0.7 }}>
                    Last used: {formatLastUsedAt(profile.lastUsedAt)}
                  </div>
                </div>
                {userRole === 'owner' ? (
                  <button
                    type="button"
                    className="secondary-btn"
                    disabled={browserProfilesBusy}
                    onClick={() => {
                      setBrowserProfileEditId(profile.id);
                      setBrowserProfileEditMode(profile.connectionMode);
                      setBrowserProfileEditConfig(
                        profile.connectionConfig.mode === 'chrome_profile'
                          ? profile.connectionConfig.chromeProfilePath
                          : profile.connectionConfig.mode === 'cdp'
                            ? profile.connectionConfig.endpointUrl
                            : '',
                      );
                      setBrowserProfileEditProfileDirectory(
                        profile.connectionConfig.mode === 'chrome_profile'
                          ? profile.connectionConfig.profileDirectory || ''
                          : '',
                      );
                      if (profile.connectionConfig.mode === 'chrome_profile') {
                        void loadChromeSubprofileDiscovery(
                          profile.connectionConfig.chromeProfilePath,
                        );
                      }
                      setBrowserProfileNotice(null);
                    }}
                  >
                    Edit
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="settings-copy" style={{ opacity: 0.6 }}>
            No browser profiles yet. Profiles are created automatically when a
            browser tool is first used, or you can add one below.
          </p>
        )}

        {browserProfileEditId ? (
          <div
            style={{
              marginTop: '1rem',
              padding: '1rem',
              border: '1px solid var(--border-color, #e5e5e5)',
              borderRadius: '6px',
            }}
          >
            <h3 style={{ margin: '0 0 0.75rem' }}>
              Edit Connection Mode
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <label>
                <input
                  type="radio"
                  name="editMode"
                  checked={browserProfileEditMode === 'managed'}
                  onChange={() => {
                    setBrowserProfileEditMode('managed');
                    setBrowserProfileEditConfig('');
                    setBrowserProfileEditProfileDirectory('');
                  }}
                />{' '}
                Managed (isolated sandbox)
              </label>
              <label>
                <input
                  type="radio"
                  name="editMode"
                  checked={browserProfileEditMode === 'chrome_profile'}
                  onChange={() => {
                    setBrowserProfileEditMode('chrome_profile');
                    void maybeAutofillChromeProfileSelection({
                      currentPath: browserProfileEditConfig,
                      currentProfileDirectory: browserProfileEditProfileDirectory,
                      setPath: setBrowserProfileEditConfig,
                      setProfileDirectory: setBrowserProfileEditProfileDirectory,
                    });
                  }}
                />{' '}
                Chrome Profile (use real Chrome cookies)
              </label>
              {browserProfileEditMode === 'chrome_profile' ? (
                renderChromeProfileSelection({
                  currentPath: browserProfileEditConfig,
                  setPath: setBrowserProfileEditConfig,
                  currentProfileDirectory: browserProfileEditProfileDirectory,
                  setProfileDirectory: setBrowserProfileEditProfileDirectory,
                })
              ) : null}
              <label>
                <input
                  type="radio"
                  name="editMode"
                  checked={browserProfileEditMode === 'cdp'}
                  onChange={() => {
                    setBrowserProfileEditMode('cdp');
                    setBrowserProfileEditProfileDirectory('');
                  }}
                />{' '}
                CDP (attach to running Chrome)
              </label>
              {browserProfileEditMode === 'cdp' ? (
                <input
                  type="text"
                  placeholder="http://localhost:9222"
                  value={browserProfileEditConfig}
                  onChange={(e) => setBrowserProfileEditConfig(e.target.value)}
                  style={{ marginLeft: '1.5rem' }}
                  />
                ) : null}
              </div>
            <div
              className="settings-copy"
              style={{
                marginTop: '0.75rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                flexWrap: 'wrap',
              }}
            >
              <span>
                If this profile is locked by an active or paused browser task,
                disconnect its blocking sessions, then save again. This
                interrupts any in-progress browser work for{' '}
                {editingBrowserProfile
                  ? formatBrowserProfileLabel(editingBrowserProfile)
                  : 'this profile'}
                .
              </span>
              <button
                type="button"
                className="secondary-btn"
                disabled={browserProfilesBusy}
                onClick={async () => {
                  if (!browserProfileEditId) return;
                  setBrowserProfilesBusy(true);
                  setBrowserProfileNotice(null);
                  try {
                    const result =
                      await releaseBrowserProfileSessions(browserProfileEditId);
                    setBrowserProfileNotice({
                      tone: 'success',
                      message:
                        result.releasedCount > 0
                          ? `Disconnected ${result.releasedCount} blocking browser ${result.releasedCount === 1 ? 'session' : 'sessions'}. Save again to apply the new connection mode.`
                          : 'No blocking browser sessions were found for this profile.',
                    });
                  } catch (err) {
                    if (err instanceof UnauthorizedError) {
                      onUnauthorized();
                      return;
                    }
                    setBrowserProfileNotice({
                      tone: 'error',
                      message:
                        err instanceof ApiError
                          ? err.message
                          : 'Failed to disconnect blocking browser sessions.',
                    });
                  } finally {
                    setBrowserProfilesBusy(false);
                  }
                }}
              >
                Disconnect Blocking Sessions
              </button>
            </div>
            <div
              className="settings-copy"
              style={{ marginTop: '0.5rem' }}
            >
              Delete removes this saved browser profile and its local managed
              browser/download cache. It does not delete your real Chrome
              profile.
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
              <button
                type="button"
                className="primary-btn"
                disabled={browserProfilesBusy}
                onClick={async () => {
                  setBrowserProfilesBusy(true);
                  setBrowserProfileNotice(null);
                  try {
                    const config =
                      browserProfileEditMode === 'chrome_profile'
                        ? {
                            chromeProfilePath: browserProfileEditConfig,
                            ...(browserProfileEditProfileDirectory.trim()
                              ? {
                                  profileDirectory:
                                    browserProfileEditProfileDirectory.trim(),
                                }
                              : {}),
                          }
                        : browserProfileEditMode === 'cdp'
                          ? { endpointUrl: browserProfileEditConfig }
                          : undefined;
                    await updateBrowserProfileConnectionMode(
                      browserProfileEditId!,
                      browserProfileEditMode,
                      config,
                    );
                    setBrowserProfileEditId(null);
                    setBrowserProfileEditProfileDirectory('');
                    setBrowserProfileNotice({
                      tone: 'success',
                      message: 'Connection mode updated.',
                    });
                    await loadBrowserProfiles();
                  } catch (err) {
                    if (err instanceof UnauthorizedError) {
                      onUnauthorized();
                      return;
                    }
                    setBrowserProfileNotice({
                      tone: 'error',
                      message:
                        err instanceof ApiError
                          ? err.code === 'active_session_exists'
                            ? `${err.message} Disconnect the blocking sessions below, or finish the paused browser task first.`
                            : err.message
                          : 'Failed to update connection mode.',
                    });
                  } finally {
                    setBrowserProfilesBusy(false);
                  }
                }}
              >
                {browserProfilesBusy ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                className="secondary-btn"
                onClick={() => {
                  setBrowserProfileEditId(null);
                  setBrowserProfileEditProfileDirectory('');
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="secondary-btn"
                disabled={browserProfilesBusy || !editingBrowserProfile}
                style={{
                  marginLeft: 'auto',
                  borderColor: 'var(--danger-color, #dc2626)',
                  color: 'var(--danger-color, #dc2626)',
                }}
                onClick={async () => {
                  if (!editingBrowserProfile) return;
                  const confirmed = globalThis.confirm(
                    `Delete browser profile ${formatBrowserProfileLabel(editingBrowserProfile)}? This keeps your real Chrome profile intact but removes this saved browser profile from Clawrocket.`,
                  );
                  if (!confirmed) {
                    return;
                  }

                  setBrowserProfilesBusy(true);
                  setBrowserProfileNotice(null);
                  try {
                    await deleteBrowserProfile(editingBrowserProfile.id);
                    setBrowserProfileEditId(null);
                    setBrowserProfileEditProfileDirectory('');
                    setBrowserProfileNotice({
                      tone: 'success',
                      message: 'Browser profile deleted.',
                    });
                    await loadBrowserProfiles();
                  } catch (err) {
                    if (err instanceof UnauthorizedError) {
                      onUnauthorized();
                      return;
                    }
                    setBrowserProfileNotice({
                      tone: 'error',
                      message:
                        err instanceof ApiError
                          ? err.code === 'active_session_exists'
                            ? `${err.message} Disconnect the blocking sessions below first.`
                            : err.message
                          : 'Failed to delete browser profile.',
                    });
                  } finally {
                    setBrowserProfilesBusy(false);
                  }
                }}
              >
                {browserProfilesBusy ? 'Deleting…' : 'Delete Profile'}
              </button>
            </div>
          </div>
        ) : null}

        {userRole === 'owner' ? (
          <>
            {!showAddProfile ? (
              <button
                type="button"
                className="secondary-btn"
                style={{ marginTop: '0.75rem' }}
                onClick={() => {
                  setShowAddProfile(true);
                  setNewProfileSiteKey('');
                  setNewProfileAccountLabel('');
                  setNewProfileMode('managed');
                  setNewProfileConfig('');
                  setNewProfileProfileDirectory('');
                  setBrowserProfileNotice(null);
                }}
              >
                Add Profile
              </button>
            ) : (
              <div
                style={{
                  marginTop: '1rem',
                  padding: '1rem',
                  border: '1px solid var(--border-color, #e5e5e5)',
                  borderRadius: '6px',
                }}
              >
                <h3 style={{ margin: '0 0 0.75rem' }}>Add Browser Profile</h3>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.5rem',
                  }}
                >
                  <input
                    type="text"
                    placeholder="Site key (e.g. linkedin)"
                    value={newProfileSiteKey}
                    onChange={(e) => setNewProfileSiteKey(e.target.value)}
                  />
                  <input
                    type="text"
                    placeholder="Account label (optional)"
                    value={newProfileAccountLabel}
                    onChange={(e) => setNewProfileAccountLabel(e.target.value)}
                  />
                  <p
                    className="settings-copy"
                    style={{ margin: '0', fontSize: '0.92rem' }}
                  >
                    Profiles are unique by site key plus account label. Use the
                    same site key with a different account label for multiple
                    accounts on one site.
                  </p>
                  {matchingNewBrowserProfile ? (
                    <div className="settings-banner settings-banner-warning">
                      This matches existing profile{' '}
                      <strong>
                        {formatBrowserProfileLabel(matchingNewBrowserProfile)}
                      </strong>{' '}
                      and it is still using{' '}
                      {formatBrowserConnectionMode(
                        matchingNewBrowserProfile.connectionMode,
                      )}
                      . Use Edit to change it, or change the account label to
                      create a second profile for the same site.
                    </div>
                  ) : null}
                  <label>
                    <input
                      type="radio"
                      name="newMode"
                      checked={newProfileMode === 'managed'}
                      onChange={() => {
                        setNewProfileMode('managed');
                        setNewProfileConfig('');
                        setNewProfileProfileDirectory('');
                      }}
                    />{' '}
                    Managed
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="newMode"
                      checked={newProfileMode === 'chrome_profile'}
                      onChange={() => {
                        setNewProfileMode('chrome_profile');
                        void maybeAutofillChromeProfileSelection({
                          currentPath: newProfileConfig,
                          currentProfileDirectory: newProfileProfileDirectory,
                          setPath: setNewProfileConfig,
                          setProfileDirectory: setNewProfileProfileDirectory,
                        });
                      }}
                    />{' '}
                    Chrome Profile
                  </label>
                  {newProfileMode === 'chrome_profile' ? (
                    renderChromeProfileSelection({
                      currentPath: newProfileConfig,
                      setPath: setNewProfileConfig,
                      currentProfileDirectory: newProfileProfileDirectory,
                      setProfileDirectory: setNewProfileProfileDirectory,
                    })
                  ) : null}
                  <label>
                    <input
                      type="radio"
                      name="newMode"
                      checked={newProfileMode === 'cdp'}
                      onChange={() => {
                        setNewProfileMode('cdp');
                        setNewProfileProfileDirectory('');
                      }}
                    />{' '}
                    CDP
                  </label>
                  {newProfileMode === 'cdp' ? (
                    <input
                      type="text"
                      placeholder="http://localhost:9222"
                      value={newProfileConfig}
                      onChange={(e) => setNewProfileConfig(e.target.value)}
                      style={{ marginLeft: '1.5rem' }}
                    />
                  ) : null}
                </div>
                <div
                  style={{
                    display: 'flex',
                    gap: '0.5rem',
                    marginTop: '0.75rem',
                  }}
                >
                  <button
                    type="button"
                    className="primary-btn"
                    disabled={
                      browserProfilesBusy ||
                      !newProfileSiteKey.trim() ||
                      matchingNewBrowserProfile !== null
                    }
                    onClick={async () => {
                      setBrowserProfilesBusy(true);
                      setBrowserProfileNotice(null);
                      try {
                        const config =
                          newProfileMode === 'chrome_profile'
                            ? {
                                chromeProfilePath: newProfileConfig,
                                ...(newProfileProfileDirectory.trim()
                                  ? {
                                      profileDirectory:
                                        newProfileProfileDirectory.trim(),
                                    }
                                  : {}),
                              }
                            : newProfileMode === 'cdp'
                              ? { endpointUrl: newProfileConfig }
                              : undefined;
                        await createBrowserProfile({
                          siteKey: newProfileSiteKey.trim(),
                          accountLabel: newProfileAccountLabel.trim() || null,
                          connectionMode: newProfileMode,
                          connectionConfig: config,
                        });
                        setShowAddProfile(false);
                        setNewProfileProfileDirectory('');
                        setBrowserProfileNotice({
                          tone: 'success',
                          message: 'Profile created.',
                        });
                        await loadBrowserProfiles();
                      } catch (err) {
                        if (err instanceof UnauthorizedError) {
                          onUnauthorized();
                          return;
                        }
                        setBrowserProfileNotice({
                          tone: 'error',
                          message:
                            err instanceof ApiError
                              ? err.message
                              : 'Failed to create profile.',
                        });
                      } finally {
                        setBrowserProfilesBusy(false);
                      }
                    }}
                  >
                    {browserProfilesBusy ? 'Creating…' : 'Create'}
                  </button>
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => {
                      setShowAddProfile(false);
                      setNewProfileProfileDirectory('');
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </>
        ) : null}
      </section>

      <section className="settings-card">
        <h2>Restart ClawRocket Service</h2>
        {!status.restartSupported ? (
          <p className="settings-copy">
            Service restart is only available when running under the systemd
            service with <code>CLAWROCKET_SELF_RESTART=1</code>.
          </p>
        ) : null}
        {status.activeRunCount > 0 ? (
          <p className="settings-copy">
            There are {status.activeRunCount} active runs that will be interrupted
            and marked as failed on next startup.
          </p>
        ) : null}
        {userRole !== 'owner' ? (
          <p className="settings-copy">
            Only the account owner can restart the service.
          </p>
        ) : null}
        {status.restartSupported && userRole === 'owner' ? (
          <button
            type="button"
            className="primary-btn"
            disabled={busySection === 'restart'}
            onClick={() => void handleRestart()}
          >
            {busySection === 'restart'
              ? 'Restarting…'
              : 'Restart ClawRocket Service'}
          </button>
        ) : null}
      </section>

      <section className="settings-card">
        <h2>Last Modified</h2>
        <p className="settings-copy">
          {settings.lastUpdatedAt
            ? `Last updated ${formatDateTime(settings.lastUpdatedAt)}${
                settings.lastUpdatedBy
                  ? ` by ${settings.lastUpdatedBy.displayName}.`
                  : '.'
              }`
            : 'Never configured.'}
        </p>
      </section>

    </section>
  );
}
