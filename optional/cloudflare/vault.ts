/** Trusted control-plane only. Never bind this object to model tools or generated facets.
 * Atomic storage transactions must be serializable (Cloudflare Durable Object storage).
 * No token refresh is retried after an ambiguous failure: reconnect explicitly instead.
 */
export interface VaultTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}
export interface AtomicStorage extends VaultTransaction {
  transaction<T>(fn: (tx: VaultTransaction) => Promise<T>): Promise<T>;
}
export interface OAuthCredential {
  type: 'oauth';
  [key: string]: unknown;
}
type State = { version: 1; hostId: string; revision: number; credential?: OAuthCredential; pending?: string };
type Envelope = { version: 1; iv: string; ciphertext: string };
const SLOT = 'subscription-vault-v1';
const enc = new TextEncoder();
const dec = new TextDecoder();
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unbase64 = (value: string) => Uint8Array.from(atob(value), char=>char.charCodeAt(0));
function checkCredential(value: OAuthCredential) {
  if (!value || value.type !== 'oauth' || enc.encode(JSON.stringify(value)).length > 65536) throw new Error('Invalid subscription credential');
}
export class SubscriptionVault {
  private storage: AtomicStorage;
  private key: CryptoKey;
  private aad: Uint8Array;
  private constructor(storage: AtomicStorage, key: CryptoKey, scope: string) {
    this.storage = storage; this.key = key;
    this.aad = enc.encode(`red-subscription-vault-v1:${scope}`);
  }
  static async create(storage: AtomicStorage, keyBytes: Uint8Array, scope: string) {
    if (keyBytes.byteLength !== 32 || !scope || scope.length > 256) throw new Error('Invalid vault configuration');
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt','decrypt']);
    return new SubscriptionVault(storage, key, scope);
  }
  private async load(tx: VaultTransaction): Promise<State | undefined> {
    const envelope = await tx.get<Envelope>(SLOT);
    if (!envelope) return undefined;
    try {
      if (envelope.version !== 1 || envelope.iv.length !== 16 || envelope.ciphertext.length > 94000) throw new Error();
      const plain = await crypto.subtle.decrypt({name:'AES-GCM',iv:unbase64(envelope.iv),additionalData:this.aad},this.key,unbase64(envelope.ciphertext));
      const state = JSON.parse(dec.decode(plain)) as State;
      if (state.version !== 1 || typeof state.hostId !== 'string' || !Number.isSafeInteger(state.revision)) throw new Error();
      return state;
    } catch { throw new Error('Vault unavailable: integrity or configuration mismatch'); }
  }
  private async save(tx: VaultTransaction, state: State) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:this.aad},this.key,enc.encode(JSON.stringify(state)));
    await tx.put(SLOT,{version:1,iv:base64(iv),ciphertext:base64(new Uint8Array(cipher))} satisfies Envelope);
  }
  /** Public-safe health only. No ID, token, metadata, or secret returned. */
  async status() {
    const state = await this.load(this.storage);
    return { connected:!!state?.credential, recoveryRequired:!!state?.pending };
  }
  /** Host ID created once in durable state, never copied from a laptop/container image. */
  async hostId() {
    return this.storage.transaction(async(tx)=>{
      let state = await this.load(tx);
      if (!state) {state={version:1,hostId:crypto.randomUUID(),revision:0};await this.save(tx,state);}
      return state.hostId;
    });
  }
  /** Initial cloud-host OAuth completion only. Do not expose as a public token-upload API. */
  async enroll(credential: OAuthCredential) {
    checkCredential(credential);
    await this.hostId();
    await this.storage.transaction(async(tx)=>{
      const state = (await this.load(tx))!;
      if (state.pending) throw new Error('Previous refresh outcome must be resolved before reconnecting');
      state.credential=structuredClone(credential);state.revision++;
      await this.save(tx,state);
    });
  }
  /** One durable refresh owner. The callback must perform at most ONE upstream refresh.
   * A process crash or failed commit leaves a persisted lock; never expire it on a timer.
   * No network call occurs inside a retried storage transaction.
   */
  async refreshOnce(refresh: (credential: OAuthCredential, hostId: string) => Promise<OAuthCredential>) {
    const claim = crypto.randomUUID();
    const input = await this.storage.transaction(async(tx)=>{
      const state = await this.load(tx);
      if (!state?.credential) throw new Error('Not connected');
      if (state.pending) throw new Error('Refresh in progress or recovery required');
      state.pending=claim;await this.save(tx,state);
      return {credential:structuredClone(state.credential),hostId:state.hostId,revision:state.revision};
    });
    // On ANY error leave the marker persisted. Upstream may have rotated its token.
    let next: OAuthCredential;
    try { next=await refresh(input.credential,input.hostId);checkCredential(next); }
    catch { throw new Error('Refresh outcome uncertain; reconnect after stopping the previous owner'); }
    await this.storage.transaction(async(tx)=>{
      const state = await this.load(tx);
      if (!state || state.pending!==claim || state.revision!==input.revision) throw new Error('Refresh ownership lost');
      state.credential=structuredClone(next);state.revision++;delete state.pending;
      await this.save(tx,state);
    });
  }
  /** Trusted inference code only; credentials never belong in agent state or response bodies. */
  async readForInference() {
    const state=await this.load(this.storage);
    if (state?.pending) throw new Error('Refresh in progress or recovery required');
    return state?.credential ? structuredClone(state.credential) : undefined;
  }
  /** Only AFTER operator verifies the old process stopped and explicitly reconnects.
   * This clears the old session rather than retrying potentially consumed credentials.
   * Requires trusted admin authorization at the caller; intentionally no HTTP endpoint.
   */
  async forgetAfterOwnerStopped() {
    await this.storage.transaction(async(tx)=>{
      const state=await this.load(tx);if(!state)return;
      delete state.credential;delete state.pending;state.revision++;await this.save(tx,state);
    });
  }
}
