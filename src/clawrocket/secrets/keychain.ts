export interface KeychainBridge {
  store(service: string, account: string, secret: string): Promise<void>;
  retrieve(service: string, account: string): Promise<string | null>;
  delete(service: string, account: string): Promise<void>;
  healthCheck(): Promise<boolean>;
}

export const noopKeychainBridge: KeychainBridge = {
  async store() {
    throw new Error('Keychain bridge is not implemented yet');
  },
  async retrieve() {
    return null;
  },
  async delete() {
    return;
  },
  async healthCheck() {
    return true;
  },
};
