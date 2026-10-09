/**
 * The API client.
 *
 * Same origin, so no base URL and no CORS. Errors carry the daemon's own error contract, including
 * the JSON Pointer and the hint, and they are surfaced rather than replaced with a generic message:
 * on a device where a wrong configuration can cost access, the hint is the useful half.
 */

export interface ApiError {
  code: string;
  message: string;
  pointer?: string;
  detail?: unknown;
  hint?: string;
}

export class ApiFailure extends Error {
  readonly status: number;
  readonly error: ApiError;

  constructor(status: number, error: ApiError) {
    super(error.message);
    this.name = 'ApiFailure';
    this.status = status;
    this.error = error;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    /*
     * The JSON content type only when there is a body to describe. The daemon refuses a request that
     * declares JSON and carries nothing — `400 "Body cannot be empty when content-type is set to
     * 'application/json'"` — before it looks at the route at all. Sent unconditionally, it broke every
     * bodyless write this client makes: revoking a token, deleting and activating a profile, removing
     * a peer, signing out. Measured on the bench board, 2026-10-07: the same `DELETE /api/tokens/:id`
     * answered 400 with the header and reached the route (403, wrong scope) without it.
     */
    headers: { ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }), ...(init?.headers ?? {}) },
    // The session cookie is HttpOnly, so the browser has to be told to send it.
    credentials: 'same-origin',
  });

  if (!response.ok) {
    let error: ApiError = { code: 'http_error', message: `${response.status} ${response.statusText}` };
    try {
      const body = (await response.json()) as { error?: ApiError };
      if (body.error) error = body.error;
    } catch {
      /* A response with no JSON body still has a status, which is what the caller acts on. */
    }
    throw new ApiFailure(response.status, error);
  }

  return (await response.json()) as T;
}

export const api = {
  health: () => request<{ ok: boolean; uptimeSeconds: number; setupComplete: boolean }>('/api/health'),
  system: () => request<SystemResponse>('/api/system'),
  inventory: () => request<InventoryResponse>('/api/inventory'),
  status: () => request<StatusResponse>('/api/status'),
  /**
   * Whether this device is running what its stored profile says.
   *
   * A separate call from `status`, because it is a different question: `status` polls the running
   * system, and this compares it with what was asked for.
   */
  drift: () => request<DriftResponse>('/api/drift'),
  /**
   * Every mechanism on the device that watches or waits for something, and whether it is doing so.
   *
   * A mechanism that is silent while idle cannot be told apart from a dead one; this is where the
   * difference is said.
   */
  observers: () => request<ObserversResponse>('/api/observers'),
  /**
   * Restarts the tunnel's own units; the configuration is untouched. A 200 can still carry
   * `restarted: false` — a unit that did not come back running — so the caller reads the flag, not
   * the status.
   */
  restartTunnel: (id: string) =>
    request<{ tunnel: string; restarted: boolean; message: string }>(
      `/api/tunnels/${encodeURIComponent(id)}/restart`,
      { method: 'POST' },
    ),
  /**
   * When each rule set in use was last refreshed on this device.
   *
   * Asked for by the Routing screen, where the sets are named. The answer is read from the files at
   * request time rather than out of the drift report, which is made every fifteen minutes.
   */
  ruleSetAges: () => request<RuleSetAgesResponse>('/api/rule-sets'),
  logs: (query: string) => request<LogsResponse>(`/api/logs${query}`),
  eventlog: (query: string) => request<EventLogResponse>(`/api/eventlog${query}`),
  /** The aggregate view. Read-only by construction: there is no route here that changes a peer. */
  fleet: () => request<FleetResponse>('/api/fleet'),
  capabilities: () => request<CapabilitiesResponse>('/api/capabilities'),
  /**
   * Recent transactions, read here only to know whether a confirmation window is open.
   *
   * `secondsRemaining` is the device's `windowCountdown`: a number only while a transaction is
   * `awaiting-confirm`, so the panel does not decide what "open" means a second time.
   */
  transactions: () =>
    request<{ transactions: { id: string; state: string; secondsRemaining: number | null }[] }>('/api/transactions'),
  /**
   * Switch the device off. The body is the confirmation the device requires, and the only body it accepts.
   *
   * Never retried: a retry that succeeded after the person had walked away would switch off a device
   * nobody was watching, which is the confirm mutation's argument in a harsher form.
   */
  powerOff: () =>
    request<{ accepted: boolean; poweringOffInSeconds: number; message: string }>('/api/system/poweroff', {
      method: 'POST',
      body: JSON.stringify({ confirm: 'poweroff' }),
    }),
  addPeer: (body: { label: string; baseUrl: string; token: string }) =>
    request<unknown>('/api/peers', { method: 'POST', body: JSON.stringify(body) }),
  removePeer: (id: string) => request<unknown>(`/api/peers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /**
   * `setupComplete` says only that the default password is still in place. It is information, never
   * a gate — see the note on the shell.
   *
   * The reply also used to declare `mustChangePassword`, removed here with the field itself. A type
   * that describes a value the wire does not carry is a promise to the next reader: they build on
   * it, `undefined` arrives, and the type that should have caught it is the thing that misled them.
   */
  login: (password: string) =>
    request<{ setupComplete: boolean }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ setupComplete: boolean }>('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  tokens: () => request<TokenSummary[]>('/api/tokens'),
  /** The only reply that ever carries the token's value: the device keeps its SHA-256 and nothing else. */
  createToken: (body: { name: string; scopes: TokenScope[]; expiresAt: string | null }) =>
    request<{ token: string; summary: TokenSummary }>('/api/tokens', { method: 'POST', body: JSON.stringify(body) }),
  deleteToken: (id: string) => request<{ ok: boolean }>(`/api/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

export type TokenScope = 'read' | 'apply' | 'admin';

export interface TokenSummary {
  id: string;
  name: string;
  scopes: TokenScope[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

/**
 * One subscription to the event stream, shared by the whole application. The browser reconnects on
 * its own, which is most of why this is server-sent events and not a socket.
 */
export function subscribeToEvents(onEvent: (event: string, data: unknown) => void): () => void {
  const source = new EventSource('/api/events');
  const forward = (name: string) => (message: MessageEvent<string>) => {
    try {
      onEvent(name, JSON.parse(message.data));
    } catch {
      /* A malformed frame is dropped rather than breaking the stream. */
    }
  };
  for (const name of ['hello', 'status', 'unit', 'station', 'log']) {
    source.addEventListener(name, forward(name) as EventListener);
  }
  return () => source.close();
}

export interface SystemResponse {
  deviceName: string;
  version: string;
  buildAt: string | null;
  runtime: string;
  startedAt: string;
  uptimeSeconds: number;
  setupComplete: boolean;
  apiEnabled: boolean;
  schemaVersion: number;
  listen: { port: number; addresses: string[]; unresolvedInterfaces: string[] };
  clock: { timezone: string | null; ntpEnabled: boolean | null; synchronized: boolean | null };
  binaries: { name: string; present: boolean; path: string | null; version: string | null; features: string[]; neededFor: string }[];
  warnings: string[];
}

export interface InventoryResponse {
  at: string;
  system: { kernel: string; architecture: string; cpuCount: number; memoryMb: number; boardModel: string | null };
  radios: {
    phy: string;
    reported: {
      interfaceModes: string[];
      interfaceCombinations: { text: string; total: number | null; channels: number | null }[];
      bus: string | null;
      usbId: string | null;
      macFromSysfs: string | null;
      antennas: { txMask: number | null; rxMask: number | null } | null;
      maxAssociatedStations: number | null;
      regulatory: { source: string; country: string | null; dfsRegion: string | null };
      interfaces: { name: string | null; type: string | null; channel: number | null; widthMhz: number | null; ssid: string | null }[];
    };
    derived: {
      canHostAccessPoint: { value: boolean; from: string };
      canHostClient: { value: boolean; from: string };
      accessPointAndClientTogether: { value: { supported: boolean; sameChannelOnly: boolean }; from: string };
      removable: { value: boolean; from: string };
      scanAllowedNow: { value: boolean; from: string };
      bands: { value: string[]; from: string };
      channels: {
        band: string;
        channel: number | null;
        frequencyMhz: number;
        maxTxPowerDbm: number | null;
        requiresRadarDetection: boolean;
        noInitiatingRadiation: boolean;
        disabled: boolean;
      }[];
    };
  }[];
  interfaces: {
    name: string;
    operstate: string | null;
    flags: string[];
    mac: string | null;
    phy: string | null;
    wirelessType: string | null;
    addresses: { family: string; address: string; prefixLength: number }[];
  }[];
  notes: string[];
}

/**
 * One divergence between the stored profile and this device.
 *
 * `stored` and `running` are both carried, and the screen shows both: a message that says a file
 * differs and not how is a message somebody has to open a terminal to act on.
 */
export interface DriftFinding {
  severity: string;
  code: string;
  kind: string;
  /** The generated file path, the unit name, or the kernel setting. */
  subject: string;
  /** A JSON Pointer **inside** `subject`, when it is a JSON file. */
  pointer: string | null;
  stored: string | null;
  running: string | null;
  message: string;
  hint: string;
  becauseOf?: string[];
}

export interface ObserverReading {
  /** For display only. This board has no clock battery; `ageSeconds` is the one to compute with. */
  at: string;
  ageSeconds: number;
  what: string;
  /** One entry per subject — a guard — when the observer reported them separately. */
  items?: {
    subject: string;
    state: string;
    note: string | null;
    /** How it was measured: for a tunnel, keepalive, gateway echo, traffic or neutral endpoints. */
    method?: string;
    /** What the mechanism did about it — including nothing, and why. */
    action?: string;
    /** `bad` is red. A tunnel that reads dead is `bad` even when nothing acted on it. */
    tone?: 'ok' | 'warn' | 'bad';
    /** While a fall-through tunnel's traffic leaves outside it: seconds on the device's monotonic clock, as of this reading. */
    fallingThroughSeconds?: number;
  }[];
}

export interface ObserversResponse {
  observers: {
    name: string;
    watches: string;
    everySeconds: number | null;
    state: 'ok' | 'stale' | 'not-running' | 'failing';
    /** Why the state is not `ok`. Null exactly when it is. */
    problem: string | null;
    lastLooked: ObserverReading | null;
    lastActed: ObserverReading | null;
  }[];
  problems: number;
}

export interface DriftResponse {
  /**
   * `null` means the check has not run once.
   *
   * It is a third answer and must stay one on this side of the wire too: rendering it the same as
   * `converged` puts the reassuring word in front of somebody in exactly the case nobody has looked.
   */
  report: {
    state: 'converged' | 'diverged' | 'no-profile' | 'unreadable';
    reason: string;
    findings: DriftFinding[];
    checked: { files: number; units: number; sysctl: number };
    omitted: number;
    error?: string;
    /** For display only. This board has no clock battery; `ageSeconds` is the one to compute with. */
    at: string;
    durationMs: number;
  } | null;
  ageSeconds: number | null;
  summary: string;
}

/**
 * How old this device's copy of one rule set is.
 *
 * `ageSeconds` is null whenever no honest number exists, and the three reasons are different
 * sentences: the clock has not been synchronised, the set has never been fetched, or the profile
 * states no interval so nothing judges it. `summary` carries whichever it is, already worded by the
 * device — this screen never computes an age, because the arithmetic is the part that needs the
 * argument about a board with no clock battery.
 */
export interface RuleSetAge {
  tag: string;
  type: string;
  state: 'fresh' | 'overdue' | 'never-fetched' | 'unreadable' | 'no-cadence' | 'unmeasurable';
  ageSeconds: number | null;
  /** The same number in words, formatted on the device. One formatter for one quantity. */
  ageLabel: string | null;
  intervalHours: number | null;
  overdueAfterSeconds: number | null;
  observedFrom: string | null;
  /**
   * False when the figure is a **lower** bound shared by every remote set.
   *
   * The core keeps them in one cache file this device cannot read inside, so the timestamp is the
   * most recent write by any of them: a fresh-looking figure says something was refreshed, not that
   * this set was. It understates, so it is never rendered as a measured age.
   */
  exact: boolean;
  summary: string;
}

export interface RuleSetAgesResponse {
  /**
   * The profile these ages are about, always the **active** one.
   *
   * A screen editing a different profile must not show them: the join between a stored set and a
   * file is a tag string, and a profile reusing a tag would be given the running profile's
   * freshness for a list this device may never have fetched.
   */
  profileId: string | null;
  sets: RuleSetAge[];
}

export interface StatusResponse {
  at: string;
  network: { links: { name: string; operstate: string | null; flags: string[] }[] } | null;
  units: Record<string, { unit: string; activeState: string | null; subState: string | null; unitFileState: string | null; isActive: boolean; isEnabled: boolean; known: boolean }>;
  accessPoints: Record<string, { status: { state: string | null; channel: number | null; frequencyMhz: number | null } | null; stations: { mac: string; signalDbm: number | null; connectedSeconds: number | null }[]; stationsComplete: boolean; stationsIncomplete: string | null }>;
  links: Record<string, { connected: boolean; ssid: string | null; signalDbm: number | null; txBitrate: { mbps: number | null; mcs: number | null; widthMhz: number | null } | null }>;
  clock: { synchronized: boolean | null; ntpEnabled: boolean | null; at: string } | null;
  stationHistory: { accessPointInterface: string; mac: string; action: string; at: string }[];
}

export interface LogsResponse {
  source: string;
  entries: { at: string | null; priority: number | null; unit: string | null; identifier: string | null; message: string; bootId: string | null }[];
  nextCursor: string | null;
  currentBootId: string | null;
  containsEarlierBoots: boolean;
  hasMore: boolean;
  incomplete: boolean;
  incompleteReason: string | null;
  currentBootEmpty: boolean;
}

export interface CapabilitiesResponse {
  capabilities: {
    id: string;
    title: string;
    state: 'available' | 'missing' | 'unknown';
    missing: string[];
    remedies: { command: string | null; note?: string }[];
    detail?: string;
  }[];
  /** Counted on the device, so two clients cannot disagree about whether `unknown` is a gap. It is not. */
  summary: { available: number; missing: number; unknown: number };
}

export interface FleetResponse {
  devices: {
    id: string;
    label: string;
    baseUrl: string;
    state: 'self' | 'answered' | 'refused' | 'unreachable';
    deviceId?: string;
    deviceName?: string;
    version?: string;
    uptimeSeconds?: number;
    activeProfile?: string | null;
    detail?: string;
  }[];
  /** Identities claimed by more than one device, which almost always means a card was copied. */
  duplicateIdentities: string[];
}

export interface EventLogResponse {
  source: string;
  capacity: number;
  count: number;
  entries: { id: number; at: string; level: string; kind: string; summary: string; detail: unknown }[];
}

/* ── profiles, plan and apply ─────────────────────────────────────────────────────────────── */

/**
 * A secret, as the interface ever sees one: whether a value is set.
 *
 * The value itself never arrives. That is why a save sends `{ $keep: true }` for a field nobody
 * touched — a form that saved what it was given would blank every secret on the first save of an
 * unrelated field, and nothing would say so until a tunnel stopped connecting.
 */
export interface SecretRead {
  $set: boolean;
}

export interface SecretKeep {
  $keep: true;
}

export interface SecretRedacted {
  $redacted: string;
}

export interface MissingSecret {
  pointer: string;
  kind: string;
}

export interface ProfileSummary {
  id: string;
  name: string;
  description: string | null;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  active: boolean;
  missingSecrets: MissingSecret[];
}

export interface Finding {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  pointer: string;
  hint: string;
  detail?: unknown;
}

export interface PlanResponse {
  blastRadius: 'hot' | 'service' | 'network' | 'boot';
  usable: boolean;
  empty: boolean;
  humanDiff: string[];
  findings: Finding[];
  notes: string[];
  bindings: { role: string; state: string; name?: string; reason?: string; candidates?: { label: string }[] }[];
  files: { path: string; purpose: string; mode: string }[];
  units: { name: string; enabled: boolean; active: boolean; purpose: string }[];
  fileChanges: { path: string; action: string; purpose: string; blastRadius: string }[];
  unitChanges: { name: string; action: string; purpose: string; blastRadius: string }[];
  sysctlChanges: { key: string; from: string | null; to: string; reason: string }[];
  interfaceRenames: { from: string; to: string; carriesManagement: boolean }[];
}

export interface ApplyResponse {
  transaction: {
    id: string;
    state: string;
    blastRadius: string;
    /** The device's own clock. Shown, never used to compute a countdown — see ConfirmationWindow. */
    deadlineAt: string | null;
    /** How long is left, as of this reply. A duration, so it means the same in both clocks. */
    secondsRemaining: number | null;
  };
  steps: { step: string; ok: boolean; detail: string; ms: number }[];
  refused: { what: string; blastRadius: string; needs: string }[];
}

/*
 * `ProviderDescriptor`, `providers()` and `tunnelSchema()` were here, and they are **deleted rather
 * than left in place unused.**
 *
 * They served the generic form: the interface asked the device which providers existed and fetched a
 * JSON Schema per provider to render controls from. Nothing calls them now — a tunnel is one of three
 * catalogue entries, each with a designed screen, and the entries are in `@wayfarer/schemas` where the
 * compiler can see them. A client method with no caller is a description of a capability this
 * interface no longer has, and the next person to read it would take it for one it does.
 *
 * The routes themselves stay on the device; what they answer changed with the catalogue.
 */
export const profileApi = {
  list: () => request<{ profiles: ProfileSummary[]; activeProfileId: string | null }>('/api/profiles'),
  get: (id: string) =>
    request<{ document: Record<string, unknown>; missingSecrets: MissingSecret[] }>(`/api/profiles/${id}`),
  create: (name: string) =>
    request<{ id: string; name: string }>('/api/profiles', { method: 'POST', body: JSON.stringify({ name }) }),
  save: (id: string, document: unknown) =>
    request<{ id: string; updatedAt: string }>(`/api/profiles/${id}`, {
      method: 'PUT',
      body: JSON.stringify(document),
    }),
  remove: (id: string) => request<{ deleted: boolean }>(`/api/profiles/${id}`, { method: 'DELETE' }),
  activate: (id: string) =>
    request<{ activeProfileId: string }>(`/api/profiles/${id}/activate`, { method: 'POST' }),
  exportRedacted: (id: string) =>
    request<{ document: unknown; secretsIncluded: boolean }>(`/api/profiles/${id}/export`),
  exportFull: (id: string) =>
    request<{ document: unknown; secretsIncluded: boolean; leavingInClear: { pointer: string; field: string; why: string }[] }>(
      `/api/profiles/${id}/export?secrets=include`,
    ),
  import: (document: unknown) =>
    request<{
      id: string;
      name: string;
      migratedFrom: number;
      migrationsApplied: string[];
      missingSecrets: MissingSecret[];
      activatable: boolean;
    }>('/api/profiles/import', { method: 'POST', body: JSON.stringify({ document }) }),

  plan: () => request<PlanResponse>('/api/plan'),
  dryRun: () => request<PlanResponse & { dryRun: true }>('/api/apply?dryRun=1', { method: 'POST', body: '{}' }),
  apply: (classes?: ('hot' | 'service')[]) =>
    request<ApplyResponse>('/api/apply', {
      method: 'POST',
      body: JSON.stringify(classes ? { classes } : {}),
    }),

  /**
   * Keep a change that is inside its confirmation window.
   *
   * A confirmation is a human act and nothing else produces one, so this is never called automatically
   * — not on reconnect, not on a retry, not by a poll that found the device healthy. A device that
   * confirmed its own changes would have a confirmation window that protected nothing.
   */
  confirmTransaction: (id: string) =>
    request<{ transaction: ApplyResponse['transaction'] }>(`/api/transactions/${id}/confirm`, {
      method: 'POST',
      body: '{}',
    }),

  profileSchema: () => request<Record<string, unknown>>('/api/schemas/profile'),
};
