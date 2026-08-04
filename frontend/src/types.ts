/**
 * Shared data contracts exchanged between the React UI and the native C++ host.
 *
 * Keep these structures aligned with `Application::BuildState()` and the
 * message handlers in `Application.cpp`.
 */

/** Supported recurrence rules. `none` represents a one-time reminder. */
export type RepeatRule = 'none' | 'daily' | 'weekdays' | 'weekly';

/** Visual and audible urgency used by both the dashboard and desktop pet. */
export type ReminderPriority = 'normal' | 'important' | 'urgent';

/** Describes whether a character asset is one image or a 4 × 2 sprite sheet. */
export type CharacterLayout = 'single' | 'sheet';

/** Light workspace palettes available before the dedicated dark theme ships. */
export type WorkspaceTheme = 'warm' | 'cloud' | 'rose';

/** Whole-interface scale applied by the dashboard WebView. */
export type WorkspaceTextSize = 'compact' | 'comfortable' | 'large';

/** Image formats produced by the local Canvas/native-save workflow. */
export type ImageExportFormat = 'png' | 'jpeg' | 'webp' | 'ico';

export interface ImageSaveResult {
  cancelled: boolean;
  path: string;
  sizeBytes: number;
}

/** Metadata for a built-in or user-imported desktop character. */
export interface CharacterProfile {
  /** Stable identifier used by native persistence and activation messages. */
  id: string;
  /** User-facing name displayed in the character wardrobe. */
  name: string;
  /** WebView-loadable URL supplied by the native host. */
  imageUrl: string;
  layout: CharacterLayout;
  /** Built-in wardrobe assets cannot be deleted. */
  builtIn: boolean;
}

/** A reminder record as stored by the native SQLite repository. */
export interface Reminder {
  id: number;
  title: string;
  /** Due time expressed as Unix epoch milliseconds. */
  dueAt: number;
  completed: boolean;
  /** Whether the native scheduler has already presented this occurrence. */
  notified: boolean;
  repeatRule: RepeatRule;
  priority: ReminderPriority;
}

/** Complete state snapshot sent by the native process to each WebView. */
export interface AppState {
  reminders: Reminder[];
  /** Native wall-clock time in Unix epoch milliseconds. */
  now: number;
  petName: string;
  soundEnabled: boolean;
  speechEnabled: boolean;
  autoHideEnabled: boolean;
  autoHideMinutes: number;
  characters: CharacterProfile[];
  activeCharacterId: string;
  workspaceTheme: WorkspaceTheme;
  workspaceTextSize: WorkspaceTextSize;
  openLastView: boolean;
  lastDashboardView: string;
  lastToolCategory: string;
}

/** Generic envelope used by every native/WebView message. */
export interface HostMessage<T = unknown> {
  type: string;
  payload?: T;
}

/** Request accepted by the allow-listed local developer-tool bridge. */
export interface ToolExecuteRequest {
  toolId:
    | 'base64'
    | 'hex'
    | 'hash'
    | 'url-encode'
    | 'numfmt'
    | 'timestamp'
    | 'uuid'
    | 'password';
  operation: string;
  input: string;
  urlSafe?: boolean;
  padded?: boolean;
}

/** Read-only metrics returned by the native system-center permission bridge. */
export interface SystemSnapshot {
  operatingSystem: string;
  osEdition: string;
  osDisplayVersion: string;
  osBuild: number;
  architecture: string;
  computerName: string;
  userName: string;
  processorName: string;
  physicalCores: number;
  logicalProcessors: number;
  processorPackages: number;
  processorMaxMegahertz: number;
  virtualizationEnabled: boolean;
  totalMemoryBytes: number;
  availableMemoryBytes: number;
  memoryLoadPercent: number;
  totalPageFileBytes: number;
  availablePageFileBytes: number;
  systemDrive: string;
  systemDiskTotalBytes: number;
  systemDiskFreeBytes: number;
  manufacturer: string;
  model: string;
  biosVersion: string;
  biosDate: string;
  primaryGraphics: string;
  primaryDisplayWidth: number;
  primaryDisplayHeight: number;
  primaryDisplayDpi: number;
  timeZone: string;
  localeName: string;
  activeNetworkAdapters: number;
  primaryNetworkAdapter: string;
  primaryIpv4: string;
  batteryPercent: number;
  acLineStatus: number;
  uptimeMilliseconds: number;
  installUnixSeconds: number;
}

/** One IPv4 TCP/UDP endpoint returned by Windows IP Helper APIs. */
export interface PortEntry {
  protocol: 'TCP' | 'UDP';
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  state: string;
  processId: number;
  processName: string;
}

/** One application registered with Windows' Programs and Features inventory. */
export interface InstalledSoftware {
  id: string;
  displayName: string;
  displayVersion: string;
  publisher: string;
  installLocation: string;
  registryPath: string;
  estimatedSizeBytes: number;
  installLocationInferred: boolean;
  currentUser: boolean;
  noRemove: boolean;
  windowsInstaller: boolean;
}

/** One exact, native-approved path associated with an installed application. */
export interface SoftwareResidual {
  path: string;
  label: string;
  kind: 'program' | 'cache' | 'personal' | 'shortcut';
  evidence: string;
  confidence: 'high' | 'medium';
  sizeBytes: number;
  itemCount: number;
  sizeTruncated: boolean;
  defaultSelected: boolean;
  personalData: boolean;
}

/** Short-lived cleanup session issued by the native safety boundary. */
export interface SoftwareCleanupPlan {
  token: string;
  softwareId: string;
  displayName: string;
  residuals: SoftwareResidual[];
}

/** Outcome of a registered uninstaller or reviewed residual cleanup. */
export interface SoftwareOperationResult {
  succeeded: boolean;
  message: string;
  removedPaths: string[];
  failedPaths: string[];
}

/** One column from SQLite table/view metadata. */
export interface DatabaseColumn {
  name: string;
  type: string;
  defaultValue: string;
  notNull: boolean;
  primaryKey: boolean;
}

/** Table, view, index or trigger returned from sqlite_master. */
export interface DatabaseObject {
  type: 'table' | 'view' | 'index' | 'trigger';
  name: string;
  tableName: string;
  sql: string;
  columns: DatabaseColumn[];
}

/** Read-only schema and file metadata for the active SQLite database. */
export interface DatabaseOverview {
  path: string;
  fileName: string;
  fileSizeBytes: number;
  pageSize: number;
  pageCount: number;
  userVersion: number;
  journalMode: string;
  objects: DatabaseObject[];
}

/** Bounded tabular result returned by the native SQLite query engine. */
export interface DatabaseQueryResult {
  columns: string[];
  rows: string[][];
  affectedRows: number;
  lastInsertId: number;
  elapsedMilliseconds: number;
  statementCount: number;
  truncated: boolean;
  wroteData: boolean;
  message: string;
}

export interface DatabasePickResult {
  cancelled: boolean;
  overview?: DatabaseOverview;
}

export interface DatabaseExecuteResult {
  result: DatabaseQueryResult;
  overview?: DatabaseOverview;
}
