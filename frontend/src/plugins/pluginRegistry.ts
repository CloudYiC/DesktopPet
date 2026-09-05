import { useSyncExternalStore } from 'react';
import { TOOL_DEFINITIONS } from '../toolbox/catalog';

const STORAGE_KEY = 'yiyi.plugins.installed.v2';
const PACKET_INSPECTOR_DEFAULT_MIGRATION_KEY =
  'yiyi.plugins.packet-inspector-default-local.v1';
type PluginState = Record<string, boolean>;

const DEFAULT_LOCAL_TOOLS = new Set([
  'json-format',
  'regex',
  'diff',
  'password',
  'url-encode',
  'packet-inspector',
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
    /*
     * Older releases created a complete registry snapshot while the packet
     * inspector still defaulted to Available. That snapshot can contain a
     * synthetic `false` even though the user never disabled the new tool.
     * Ignore it exactly once; later explicit disable actions remain honored.
     */
    if (window.localStorage.getItem(PACKET_INSPECTOR_DEFAULT_MIGRATION_KEY) !== '1') {
      delete saved['packet-inspector'];
      try {
        window.localStorage.setItem(PACKET_INSPECTOR_DEFAULT_MIGRATION_KEY, '1');
      } catch {
        // Storage restrictions must not discard the rest of the saved registry.
      }
    }
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
