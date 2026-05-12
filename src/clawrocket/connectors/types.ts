export type ConnectorKind = 'google_docs' | 'google_sheets' | 'posthog';

export type DataConnectorVerificationStatus =
  | 'missing'
  | 'not_verified'
  | 'verifying'
  | 'verified'
  | 'invalid'
  | 'unavailable';

export type PersistedDataConnectorVerificationStatus = Exclude<
  DataConnectorVerificationStatus,
  'missing'
>;

export interface DataConnectorRecord {
  id: string;
  name: string;
  connector_kind: ConnectorKind;
  config_json: string | null;
  discovered_json: string | null;
  enabled: number;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
}

export interface DataConnectorSecretRecord {
  connector_id: string;
  ciphertext: string;
  updated_at: string;
  updated_by: string | null;
}

export interface DataConnectorVerificationRecord {
  connector_id: string;
  status: PersistedDataConnectorVerificationStatus;
  last_verified_at: string | null;
  last_error: string | null;
  updated_at: string;
}

export interface TalkDataConnectorRecord {
  talk_id: string;
  connector_id: string;
  attached_at: string;
  attached_by: string | null;
}

export type ConnectorSecretPayload =
  | {
      kind: 'posthog';
      apiKey: string;
    }
  | {
      kind: 'google_docs';
      accessToken: string;
      refreshToken?: string;
      expiryDate?: string | null;
      scopes?: string[];
    }
  | {
      kind: 'google_sheets';
      accessToken: string;
      refreshToken?: string;
      expiryDate?: string | null;
      scopes?: string[];
    };
