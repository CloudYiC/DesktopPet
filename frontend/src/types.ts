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

/** Metadata for a built-in or user-imported desktop character. */
export interface CharacterProfile {
  /** Stable identifier used by native persistence and activation messages. */
  id: string;
  /** User-facing name displayed in the character wardrobe. */
  name: string;
  /** WebView-loadable URL supplied by the native host. */
  imageUrl: string;
  layout: CharacterLayout;
  /** Built-in characters cannot be renamed or deleted. */
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
}

/** Generic envelope used by every native/WebView message. */
export interface HostMessage<T = unknown> {
  type: string;
  payload?: T;
}
