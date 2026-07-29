import type {
  AppState,
  CharacterLayout,
  HostMessage,
  Reminder,
  ReminderPriority,
  RepeatRule,
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
    case 'character.rename':
      mockState = {
        ...mockState,
        characters: mockState.characters.map((character) =>
          character.id === String(payload.id)
            ? { ...character, name: String(payload.name ?? character.name) }
            : character,
        ),
      };
      emitMockState();
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
      };
      emitMockState();
      break;
    default:
      break;
  }
}

if (nativeBridge) {
  // WebView2 raises a DOM-style event for messages posted by the C++ host.
  nativeBridge.addEventListener('message', (event) => {
    emit(event.data as HostMessage);
  });
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

/** Indicates whether the current page is hosted by the native WebView2 process. */
export const isNativeHost = Boolean(nativeBridge);
