import { useSyncExternalStore } from 'react';
import { TOOL_DEFINITIONS } from '../toolbox/catalog';

const STORAGE_KEY = 'yiyi.plugins.installed.v2';
type PluginState = Record<string, boolean>;

const DEFAULT_LOCAL_TOOLS = new Set([
  'json-format',
  'regex',
  'diff',
  'password',
  'url-encode',
  'system-inspector',
  'port-manager',
  'software-uninstaller',
  'database-studio',
  'image-toolbox',
]);

const listeners = new Set<() => void>();

function readState(): PluginState {
  const defaults = Object.fromEntries(
    TOOL_DEFINITIONS
      .map((tool) => [tool.id, DEFAULT_LOCAL_TOOLS.has(tool.id)]),
  );
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as PluginState;
    return { ...defaults, ...saved };
  } catch {
    return defaults;
  }
}

let currentState = readState();

function emitChange() {
  listeners.forEach((listener) => listener());
}

export function setPluginEnabled(toolId: string, enabled: boolean) {
  currentState = { ...currentState, [toolId]: enabled };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(currentState));
  } catch {
    // Locked WebView storage affects persistence only, not the current session.
  }
  emitChange();
}

export function isPluginEnabled(toolId: string) {
  return currentState[toolId] !== false;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return currentState;
}

/** Reactive local registry used by both the store and tool launcher. */
export function usePluginRegistry() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
