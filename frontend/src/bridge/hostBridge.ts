import type {
  AppState,
  CharacterLayout,
  HostMessage,
  Reminder,
  ReminderPriority,
  RepeatRule,
  PortEntry,
  SystemSnapshot,
  ToolExecuteRequest,
  DatabaseExecuteResult,
  DatabaseOverview,
  DatabasePickResult,
  ImageExportFormat,
  ImageSaveResult,
  InstalledSoftware,
  SoftwareCleanupPlan,
  SoftwareOperationResult,
} from '../types';

/**
 * Minimal WebView2 bridge surface consumed by this application.
 *
 * Declaring only the members used here keeps browser preview builds independent
 * from the full WebView2 type package.
 */
interface WebViewBridge {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

declare global {
  interface Window {
    chrome?: {
      webview?: WebViewBridge;
    };
  }
}

type Listener = (message: HostMessage) => void;

const listeners = new Set<Listener>();
const nativeBridge = window.chrome?.webview;
let toolRequestSequence = 0;

interface PendingToolRequest {
  resolve(output: string): void;
  reject(error: Error): void;
  timeout: number;
}

const pendingToolRequests = new Map<string, PendingToolRequest>();
const pendingNativeRequests = new Map<string, PendingToolRequest>();

/*
 * Vite's browser preview has no native process. This in-memory state implements
 * the same message protocol so the UI remains testable with `npm run dev`.
 */
let mockState: AppState = {
  reminders: [
    {
      id: 1,
      title: '给自己泡一杯水',
      dueAt: Date.now() + 26 * 60 * 1000,
      completed: false,
      notified: false,
      repeatRule: 'none',
      priority: 'important',
    },
  ],
  now: Date.now(),
  petName: '可爱依依',
  soundEnabled: true,
  speechEnabled: false,
  autoHideEnabled: true,
  autoHideMinutes: 10,
  characters: [
    {
      id: 'builtin',
      name: '经典小鼠',
      imageUrl: '/assets/milo-sprite.png',
      layout: 'sheet',
      builtIn: true,
    },
  ],
  activeCharacterId: 'builtin',
  workspaceTheme: 'warm',
  workspaceTextSize: 'comfortable',
  openLastView: true,
  lastDashboardView: 'today',
  lastToolCategory: '',
};

function emit(message: HostMessage) {
  listeners.forEach((listener) => listener(message));
}

function emitMockState() {
  emit({ type: 'state.sync', payload: { ...mockState, now: Date.now() } });
}

function announceMockReminder(reminder: Reminder) {
  // Mirror the native alert closely enough to exercise sound/speech settings.
  if (mockState.soundEnabled) {
    const AudioContextType = window.AudioContext;
    if (AudioContextType) {
      const context = new AudioContextType();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.setValueAtTime(reminder.priority === 'urgent' ? 880 : 660, context.currentTime);
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.32);
      oscillator.connect(gain).connect(context.destination);
      oscillator.addEventListener('ended', () => void context.close(), { once: true });
      oscillator.start();
      oscillator.stop(context.currentTime + 0.34);
    }
  }
  if (mockState.speechEnabled && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(
      `${mockState.petName}提醒你，${reminder.title}`,
    );
    utterance.lang = 'zh-CN';
    window.speechSynthesis.speak(utterance);
  }
}

function handleMockMessage(message: HostMessage<Record<string, unknown>>) {
  const payload = message.payload ?? {};
  switch (message.type) {
    case 'app.ready':
    case 'reminder.list':
      window.setTimeout(emitMockState, 40);
      break;
    case 'reminder.create': {
      const reminder: Reminder = {
        id: Date.now(),
        title: String(payload.title ?? '新事项'),
        dueAt: Number(payload.dueAt ?? Date.now()),
        completed: false,
        notified: false,
        repeatRule: String(payload.repeatRule ?? 'none') as RepeatRule,
        priority: String(payload.priority ?? 'normal') as ReminderPriority,
      };
      mockState = {
        ...mockState,
        reminders: [...mockState.reminders, reminder].sort(
          (left, right) => left.dueAt - right.dueAt,
        ),
      };
      emitMockState();
      if (reminder.dueAt <= Date.now() + 11_000) {
        window.setTimeout(
          () => {
            announceMockReminder(reminder);
            emit({ type: 'reminder.triggered', payload: reminder });
          },
          Math.max(100, reminder.dueAt - Date.now()),
        );
      }
      break;
    }
    case 'reminder.complete': {
      const completedId = Number(payload.id);
      mockState = {
        ...mockState,
        reminders: mockState.reminders.flatMap((reminder) => {
          if (reminder.id !== completedId) return [reminder];
          if (reminder.repeatRule === 'none') return [];
          // Advance from the prior occurrence to preserve the user's local time.
          const dayCount = reminder.repeatRule === 'weekly' ? 7 : 1;
          const next = new Date(reminder.dueAt);
          do {
            next.setDate(next.getDate() + dayCount);
            if (reminder.repeatRule === 'weekdays') {
              while (next.getDay() === 0 || next.getDay() === 6) {
                next.setDate(next.getDate() + 1);
              }
            }
          } while (next.getTime() <= Date.now());
          return [{ ...reminder, dueAt: next.getTime(), notified: false }];
        }),
      };
      emit({ type: 'reminder.completed', payload: { id: completedId } });
      emitMockState();
      break;
    }
    case 'reminder.delete':
      mockState = {
        ...mockState,
        reminders: mockState.reminders.filter(
          (reminder) => reminder.id !== Number(payload.id),
        ),
      };
      emitMockState();
      break;
    case 'reminder.snooze':
      mockState = {
        ...mockState,
        reminders: mockState.reminders.map((reminder) =>
          reminder.id === Number(payload.id)
            ? { ...reminder, dueAt: Date.now() + Number(payload.minutes ?? 5) * 60_000 }
            : reminder,
        ),
      };
      emit({ type: 'reminder.dismissed', payload });
      emitMockState();
      break;
    case 'pet.action':
      emit(message);
      break;
    case 'character.upload': {
      const dataUrl = String(payload.dataUrl ?? '');
      const character = {
        id: `mock-${Date.now()}`,
        name: String(payload.name ?? '新角色'),
        imageUrl: dataUrl,
        layout: String(payload.layout ?? 'single') as CharacterLayout,
        builtIn: false,
      };
      mockState = {
        ...mockState,
        characters: [...mockState.characters, character],
        activeCharacterId: character.id,
      };
      emitMockState();
      break;
    }
    case 'character.activate':
      if (mockState.characters.some((character) => character.id === String(payload.id))) {
        mockState = { ...mockState, activeCharacterId: String(payload.id) };
        emitMockState();
      }
      break;
    case 'character.delete': {
      const id = String(payload.id);
      mockState = {
        ...mockState,
        characters: mockState.characters.filter(
          (character) => character.builtIn || character.id !== id,
        ),
        activeCharacterId: mockState.activeCharacterId === id
          ? 'builtin'
          : mockState.activeCharacterId,
      };
      emitMockState();
      break;
    }
    case 'settings.update':
      mockState = {
        ...mockState,
        petName: String(payload.petName ?? mockState.petName),
        soundEnabled: Boolean(payload.soundEnabled ?? mockState.soundEnabled),
        speechEnabled: Boolean(payload.speechEnabled ?? mockState.speechEnabled),
        autoHideEnabled: Boolean(
          payload.autoHideEnabled ?? mockState.autoHideEnabled,
        ),
        autoHideMinutes: Number(
          payload.autoHideMinutes ?? mockState.autoHideMinutes,
        ),
        workspaceTheme: String(
          payload.workspaceTheme ?? mockState.workspaceTheme,
        ) as AppState['workspaceTheme'],
        workspaceTextSize: String(
          payload.workspaceTextSize ?? mockState.workspaceTextSize,
        ) as AppState['workspaceTextSize'],
        openLastView: Boolean(payload.openLastView ?? mockState.openLastView),
      };
      emitMockState();
      break;
    case 'workspace.navigation.update':
      mockState = {
        ...mockState,
        lastDashboardView: String(payload.view ?? mockState.lastDashboardView),
        lastToolCategory: String(payload.category ?? mockState.lastToolCategory),
      };
      break;
    default:
      break;
  }
}

if (nativeBridge) {
  // WebView2 raises a DOM-style event for messages posted by the C++ host.
  nativeBridge.addEventListener('message', (event) => {
    const message = event.data as HostMessage<{
      requestId?: string;
      output?: string;
      message?: string;
      snapshot?: SystemSnapshot;
      entries?: PortEntry[];
    }>;
    if (message.type === 'tool.result' || message.type === 'tool.error') {
      const requestId = message.payload?.requestId ?? '';
      const pending = pendingToolRequests.get(requestId);
      if (pending) {
        window.clearTimeout(pending.timeout);
        pendingToolRequests.delete(requestId);
        if (message.type === 'tool.result') {
          pending.resolve(message.payload?.output ?? '');
        } else {
          pending.reject(new Error(message.payload?.message ?? '工具执行失败。'));
        }
      }
    }
    if (message.type.startsWith('system.snapshot.') ||
        message.type.startsWith('database.') ||
        message.type.startsWith('image.') ||
        message.type.startsWith('software.') ||
        message.type.startsWith('ports.list.') ||
        message.type.startsWith('ports.terminate.')) {
      const requestId = message.payload?.requestId ?? '';
      const pending = pendingNativeRequests.get(requestId);
      if (pending) {
        window.clearTimeout(pending.timeout);
        pendingNativeRequests.delete(requestId);
        if (message.type.endsWith('.error')) {
          pending.reject(new Error(message.payload?.message ?? '原生请求失败。'));
        } else {
          pending.resolve(JSON.stringify(message.payload ?? {}));
        }
      }
    }
    emit(message);
  });
}

function requestNativePayload<T>(
  type: string,
  payload: Record<string, unknown>,
  timeoutMilliseconds = 12_000,
) {
  const requestId = `native-${Date.now()}-${++toolRequestSequence}`;
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingNativeRequests.delete(requestId);
      reject(new Error('系统请求超时，请稍后重试。'));
    }, timeoutMilliseconds);
    pendingNativeRequests.set(requestId, {
      resolve: (serialized) => resolve(JSON.parse(serialized) as T),
      reject,
      timeout,
    });
    nativeBridge?.postMessage({ type, payload: { requestId, ...payload } });
  });
}

/** Reads non-sensitive system metrics through a dedicated read-only bridge. */
export async function requestSystemSnapshot(): Promise<SystemSnapshot> {
  if (!nativeBridge) {
    return {
      operatingSystem: 'Windows 浏览器预览',
      osEdition: 'Windows 11 专业版',
      osDisplayVersion: '24H2',
      osBuild: 26100,
      architecture: 'x64',
      computerName: 'YIYI-DESKTOP',
      userName: '本地用户',
      processorName: 'AMD Ryzen 7 7840HS with Radeon 780M Graphics',
      physicalCores: 8,
      logicalProcessors: navigator.hardwareConcurrency || 8,
      processorPackages: 1,
      processorMaxMegahertz: 3800,
      virtualizationEnabled: true,
      totalMemoryBytes: 16 * 1024 ** 3,
      availableMemoryBytes: 9 * 1024 ** 3,
      memoryLoadPercent: 44,
      totalPageFileBytes: 24 * 1024 ** 3,
      availablePageFileBytes: 15 * 1024 ** 3,
      systemDrive: 'C:\\',
      systemDiskTotalBytes: 512 * 1024 ** 3,
      systemDiskFreeBytes: 268 * 1024 ** 3,
      manufacturer: 'CloudYi Preview',
      model: 'Desktop Reference',
      biosVersion: '1.0.0',
      biosDate: '2026-01-01',
      primaryGraphics: 'AMD Radeon 780M Graphics',
      primaryDisplayWidth: window.screen.width,
      primaryDisplayHeight: window.screen.height,
      primaryDisplayDpi: 96,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      localeName: navigator.language,
      activeNetworkAdapters: 1,
      primaryNetworkAdapter: '以太网',
      primaryIpv4: '192.168.1.100',
      batteryPercent: 255,
      acLineStatus: 1,
      uptimeMilliseconds: 3 * 24 * 60 * 60 * 1000,
      installUnixSeconds: Math.floor(new Date('2025-01-15').getTime() / 1000),
    };
  }
  const response = await requestNativePayload<{ snapshot: SystemSnapshot }>(
    'system.snapshot',
    {},
  );
  return response.snapshot;
}

const mockDatabaseOverview: DatabaseOverview = {
  path: 'C:\\Preview\\cloudyi-demo.db',
  fileName: 'cloudyi-demo.db',
  fileSizeBytes: 48 * 1024,
  pageSize: 4096,
  pageCount: 12,
  userVersion: 1,
  journalMode: 'wal',
  objects: [
    {
      type: 'table',
      name: 'projects',
      tableName: 'projects',
      sql: 'CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT)',
      columns: [
        { name: 'id', type: 'INTEGER', defaultValue: '', notNull: false, primaryKey: true },
        { name: 'name', type: 'TEXT', defaultValue: '', notNull: true, primaryKey: false },
        { name: 'status', type: 'TEXT', defaultValue: "'active'", notNull: false, primaryKey: false },
      ],
    },
    {
      type: 'index',
      name: 'idx_projects_status',
      tableName: 'projects',
      sql: 'CREATE INDEX idx_projects_status ON projects(status)',
      columns: [],
    },
  ],
};

/** Opens the native SQLite picker, or a deterministic database in web preview. */
export async function requestDatabasePick(createNew = false): Promise<DatabasePickResult> {
  if (!nativeBridge) return { cancelled: false, overview: mockDatabaseOverview };
  return requestNativePayload<DatabasePickResult>('database.pick', { createNew });
}

export async function requestDatabaseRefresh(): Promise<DatabaseOverview> {
  if (!nativeBridge) return mockDatabaseOverview;
  const payload = await requestNativePayload<{ overview: DatabaseOverview }>(
    'database.refresh',
    {},
  );
  return payload.overview;
}

export async function requestDatabaseExecute(
  sql: string,
  allowWrite: boolean,
): Promise<DatabaseExecuteResult> {
  if (!nativeBridge) {
    const normalized = sql.trim().toLocaleLowerCase('en-US');
    const wroteData = !normalized.startsWith('select') && !normalized.startsWith('pragma');
    if (wroteData && !allowWrite) {
      throw new Error('当前处于只读模式；请先明确启用“允许写入”。');
    }
    return {
      result: normalized.startsWith('select')
        ? {
            columns: ['id', 'name', 'status'],
            rows: [['1', 'CloudYi Assistant', 'active'], ['2', 'Database Studio', 'active']],
            affectedRows: 0,
            lastInsertId: 0,
            elapsedMilliseconds: 2,
            statementCount: 1,
            truncated: false,
            wroteData: false,
            message: '查询完成，返回 2 行。',
          }
        : {
            columns: [], rows: [], affectedRows: 1, lastInsertId: 3,
            elapsedMilliseconds: 1, statementCount: 1, truncated: false,
            wroteData: true, message: '执行完成，影响 1 行。',
          },
      overview: wroteData ? mockDatabaseOverview : undefined,
    };
  }
  return requestNativePayload<DatabaseExecuteResult>('database.execute', {
    sql,
    allowWrite,
  });
}

export async function requestDatabaseClose(): Promise<void> {
  if (!nativeBridge) return;
  await requestNativePayload<Record<string, never>>('database.close', {});
}

/** Saves an image through the native dialog, or downloads it in web preview. */
export async function requestImageSave(
  dataUrl: string,
  format: ImageExportFormat,
  suggestedBaseName: string,
): Promise<ImageSaveResult> {
  const extension = format === 'jpeg' ? 'jpg' : format;
  if (!nativeBridge) {
    const anchor = document.createElement('a');
    anchor.href = dataUrl;
    anchor.download = `${suggestedBaseName || 'converted-image'}.${extension}`;
    anchor.click();
    const encoded = dataUrl.slice(dataUrl.indexOf(',') + 1);
    return {
      cancelled: false,
      path: anchor.download,
      sizeBytes: Math.floor(encoded.length * 0.75),
    };
  }
  return requestNativePayload<ImageSaveResult>(
    'image.save',
    { dataUrl, format, suggestedBaseName },
    5 * 60_000,
  );
}

/** Enumerates local IPv4 endpoints through the read-only port bridge. */
export async function requestPortEntries(): Promise<PortEntry[]> {
  if (!nativeBridge) {
    return [
      { protocol: 'TCP', localAddress: '*', localPort: 4173, remoteAddress: '*', remotePort: 0, state: '监听', processId: 35268, processName: 'node.exe' },
      { protocol: 'TCP', localAddress: '127.0.0.1', localPort: 9222, remoteAddress: '127.0.0.1', remotePort: 52341, state: '已连接', processId: 20480, processName: 'msedgewebview2.exe' },
      { protocol: 'UDP', localAddress: '*', localPort: 5353, remoteAddress: '—', remotePort: 0, state: '监听', processId: 1640, processName: 'svchost.exe' },
    ];
  }
  const response = await requestNativePayload<{ entries: PortEntry[] }>(
    'ports.list',
    {},
  );
  return response.entries;
}

/** Ends a revalidated port owner after the UI has obtained explicit consent. */
export async function terminatePortProcess(entry: PortEntry): Promise<string> {
  if (!nativeBridge) {
    throw new Error('浏览器预览不会结束任何真实进程。');
  }
  const response = await requestNativePayload<{ message: string }>(
    'ports.terminate',
    {
      processId: entry.processId,
      processName: entry.processName,
      confirmed: true,
    },
  );
  return response.message;
}

const mockInstalledSoftware: InstalledSoftware[] = [
  {
    id: 'HKCU|64|CloudYiEditor',
    displayName: 'CloudYi 示例编辑器',
    displayVersion: '1.102.3',
    publisher: 'CloudYi Preview',
    installLocation: 'C:\\Users\\Preview\\AppData\\Local\\Programs\\CloudYiEditor',
    registryPath: 'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CloudYiEditor (64 位视图)',
    estimatedSizeBytes: 420 * 1024 ** 2,
    installLocationInferred: false,
    currentUser: true,
    noRemove: false,
    windowsInstaller: false,
  },
  {
    id: 'HKLM|64|Git_is1',
    displayName: 'Git',
    displayVersion: '2.50.1',
    publisher: 'The Git Development Community',
    installLocation: 'C:\\Program Files\\Git',
    registryPath: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Git_is1 (64 位视图)',
    estimatedSizeBytes: 360 * 1024 ** 2,
    installLocationInferred: false,
    currentUser: false,
    noRemove: false,
    windowsInstaller: false,
  },
];

/** Reads registered desktop applications without inspecting arbitrary folders. */
export async function requestInstalledSoftware(): Promise<InstalledSoftware[]> {
  if (!nativeBridge) return mockInstalledSoftware;
  const response = await requestNativePayload<{ entries: InstalledSoftware[] }>(
    'software.list',
    {},
    30_000,
  );
  return response.entries;
}

/** Creates a short-lived, exact cleanup allowlist for one selected application. */
export async function requestSoftwareResidualScan(
  software: InstalledSoftware,
): Promise<SoftwareCleanupPlan> {
  if (!nativeBridge) {
    return {
      token: 'preview-does-not-delete-anything',
      softwareId: software.id,
      displayName: software.displayName,
      residuals: software.installLocation ? [
        {
          path: software.installLocation,
          label: '注册安装目录',
          kind: 'program',
          evidence: 'Windows 卸载项直接提供 InstallLocation',
          confidence: 'high',
          sizeBytes: software.estimatedSizeBytes,
          itemCount: 320,
          sizeTruncated: false,
          defaultSelected: true,
          personalData: false,
        },
      ] : [],
    };
  }
  const response = await requestNativePayload<{ plan: SoftwareCleanupPlan }>(
    'software.scan',
    { softwareId: software.id, displayName: software.displayName },
    60_000,
  );
  return response.plan;
}

/** Starts the application's registered interactive uninstaller. */
export async function requestSoftwareUninstall(
  software: InstalledSoftware,
): Promise<SoftwareOperationResult> {
  if (!nativeBridge) throw new Error('浏览器预览不会卸载任何真实软件。');
  const response = await requestNativePayload<{
    operation: SoftwareOperationResult;
  }>('software.uninstall', {
    softwareId: software.id,
    displayName: software.displayName,
    confirmed: true,
  });
  return response.operation;
}

/** Moves only reviewed, native-approved residual paths to the Recycle Bin. */
export async function requestSoftwareCleanup(
  plan: SoftwareCleanupPlan,
  selectedPaths: string[],
  typedName: string,
): Promise<SoftwareOperationResult> {
  if (!nativeBridge) throw new Error('浏览器预览不会删除任何真实文件。');
  const response = await requestNativePayload<{
    operation: SoftwareOperationResult;
  }>('software.cleanup', {
    planToken: plan.token,
    selectedPaths,
    typedName,
    confirmed: true,
  }, 5 * 60_000);
  return response.operation;
}

/** Executes the browser-preview equivalent of a native C core operation. */
async function executeMockTool(request: ToolExecuteRequest) {
  const bytes = new TextEncoder().encode(request.input);
  if (request.toolId === 'base64') {
    if (request.operation === 'encode') {
      let binary = '';
      bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
      let output = window.btoa(binary);
      if (request.urlSafe) output = output.replace(/\+/g, '-').replace(/\//g, '_');
      if (request.padded === false) output = output.replace(/=+$/, '');
      return output;
    }
    const normalized = request.input.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const binary = window.atob(padded);
    const decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(decoded);
  }
  if (request.toolId === 'hex') {
    if (request.operation === 'encode') {
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
    const compact = request.input.replace(/^0x/i, '').replace(/[\s_]/g, '');
    if (!/^(?:[0-9a-f]{2})*$/i.test(compact)) throw new Error('Hex 内容格式不正确。');
    const decoded = Uint8Array.from(
      compact.match(/../g) ?? [],
      (pair) => Number.parseInt(pair, 16),
    );
    return new TextDecoder('utf-8', { fatal: true }).decode(decoded);
  }
  if (request.toolId === 'url-encode') {
    if (request.operation === 'decode') return decodeURIComponent(request.input.replace(/\+/g, ' '));
    if (request.operation === 'encode-url') return encodeURI(request.input);
    return encodeURIComponent(request.input);
  }
  if (request.toolId === 'hash' && request.operation === 'sha256') {
    const digest = await window.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  if (request.toolId === 'numfmt') {
    const compact = request.input.trim().replace(/[,_\s]/g, '');
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(compact)) {
      throw new Error('请输入普通十进制数字。');
    }
    const negative = compact.startsWith('-');
    const unsigned = compact.replace(/^[+-]/, '');
    const [integer = '0', fraction] = unsigned.split('.');
    const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${negative ? '-' : ''}${grouped || '0'}${fraction ? `.${fraction}` : ''}`;
  }
  if (request.toolId === 'timestamp') {
    if (!/^-?\d+$/.test(request.input.trim())) throw new Error('时间戳必须是整数。');
    const raw = Number(request.input.trim());
    const milliseconds = request.operation === 'seconds' ? raw * 1000 : raw;
    const date = new Date(milliseconds);
    if (!Number.isFinite(milliseconds) || Number.isNaN(date.getTime())) {
      throw new Error('时间戳超出支持范围。');
    }
    return date.toISOString();
  }
  if (request.toolId === 'uuid') {
    const count = Number(request.input.trim());
    if (!Number.isInteger(count) || count < 1 || count > 50) {
      throw new Error('UUID 数量需要是 1 到 50 之间的整数。');
    }
    return Array.from({ length: count }, () => createPreviewUuid(request.operation === 'v7'))
      .join('\n');
  }
  if (request.toolId === 'password') {
    const length = Number(request.input.trim());
    if (!Number.isInteger(length) || length < 4 || length > 128) {
      throw new Error('密码长度需要是 4 到 128 之间的整数。');
    }
    return createPreviewPassword(length, request.operation);
  }
  throw new Error('浏览器预览暂不支持这个操作，请在桌面版中使用。');
}

function randomPreviewIndex(length: number) {
  const value = window.crypto.getRandomValues(new Uint32Array(1))[0];
  return value % length;
}

function formatPreviewUuid(bytes: Uint8Array) {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function createPreviewUuid(version7: boolean) {
  const bytes = window.crypto.getRandomValues(new Uint8Array(16));
  if (version7) {
    let timestamp = Date.now();
    for (let index = 5; index >= 0; index -= 1) {
      bytes[index] = timestamp & 0xff;
      timestamp = Math.floor(timestamp / 256);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
  } else {
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
  }
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatPreviewUuid(bytes);
}

function createPreviewPassword(length: number, operation: string) {
  const groups = operation === 'pin'
    ? ['0123456789']
    : operation === 'strong'
      ? ['abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789', '!@#$%^&*()-_=+[]{};:,.?/']
      : ['abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789'];
  const all = groups.join('');
  const characters = groups.map((group) => group[randomPreviewIndex(group.length)]);
  while (characters.length < length) characters.push(all[randomPreviewIndex(all.length)]);
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swapIndex = randomPreviewIndex(index + 1);
    [characters[index], characters[swapIndex]] = [characters[swapIndex], characters[index]];
  }
  return characters.join('');
}

/**
 * Posts a typed command to C++ or routes it to the browser-preview mock.
 *
 * @param type Protocol command name, such as `reminder.create`.
 * @param payload JSON-serializable command data.
 */
export function postHostMessage<T extends Record<string, unknown>>(
  type: string,
  payload?: T,
) {
  const message: HostMessage<T> = payload ? { type, payload } : { type };
  if (nativeBridge) {
    nativeBridge.postMessage(message);
  } else {
    handleMockMessage(message);
  }
}

/**
 * Registers a host-message listener.
 *
 * @returns A cleanup callback suitable for a React effect.
 */
export function subscribeHost(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Runs a portable CloudYi tool through C++/C and resolves its textual result.
 * Browser preview uses equivalent Web APIs so the React layout remains easy
 * to inspect without starting the native process.
 */
export function executeTool(request: ToolExecuteRequest): Promise<string> {
  if (!nativeBridge) {
    return executeMockTool(request).catch((error: unknown) => {
      throw error instanceof Error ? error : new Error('工具执行失败。');
    });
  }

  const requestId = `tool-${Date.now()}-${++toolRequestSequence}`;
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingToolRequests.delete(requestId);
      reject(new Error('工具执行超时，请缩短输入后重试。'));
    }, 12_000);
    pendingToolRequests.set(requestId, { resolve, reject, timeout });
    nativeBridge.postMessage({
      type: 'tool.execute',
      payload: { requestId, ...request },
    });
  });
}

/** Indicates whether the current page is hosted by the native WebView2 process. */
export const isNativeHost = Boolean(nativeBridge);
