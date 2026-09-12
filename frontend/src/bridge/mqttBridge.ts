import { isNativeHost, requestNativePayload } from './hostBridge';

export type MqttQos = 0 | 1 | 2;
export type MqttPayloadMode = 'text' | 'hex';
export type MqttSessionState = 'stopped' | 'connecting' | 'connected' | 'stopping' | 'error';

export interface MqttStartOptions {
  host: string;
  port: number;
  clientId: string;
  username: string;
  password: string;
  keepAlive: number;
  cleanSession: boolean;
  tls: boolean;
}

export interface MqttSubscription {
  topic: string;
  qos: MqttQos;
}

export interface MqttSessionSnapshot {
  state: MqttSessionState;
  brokerHost: string;
  brokerPort: number;
  clientId: string;
  tls: boolean;
  sessionPresent: boolean;
  subscriptions: MqttSubscription[];
  rxMessages: number;
  rxBytes: number;
  txMessages: number;
  txBytes: number;
  lastError: string;
}

export interface MqttEvent {
  id: number;
  timestamp: number;
  kind: 'message' | 'published' | 'status' | 'error';
  topic?: string;
  qos?: MqttQos;
  retain?: boolean;
  byteLength?: number;
  payloadHex?: string;
  message?: string;
}

export interface MqttPollResult {
  snapshot: MqttSessionSnapshot;
  events: MqttEvent[];
}

function requireNative() {
  if (!isNativeHost) {
    throw new Error('MQTT 客户端仅在 Windows 桌面版中可用，浏览器预览不会建立连接。');
  }
}

/** Starts one MQTT 3.1.1 client session without persisting credentials. */
export async function requestMqttStart(options: MqttStartOptions) {
  requireNative();
  const result = await requestNativePayload<{ snapshot: MqttSessionSnapshot }>(
    'mqtt.start', { ...options }, 15_000,
  );
  return result.snapshot;
}

export async function requestMqttStop() {
  requireNative();
  const result = await requestNativePayload<{ snapshot: MqttSessionSnapshot }>(
    'mqtt.stop', {},
  );
  return result.snapshot;
}

export async function requestMqttPoll(): Promise<MqttPollResult> {
  requireNative();
  return requestNativePayload<MqttPollResult>('mqtt.poll', {}, 10_000);
}

export async function requestMqttSubscribe(topic: string, qos: MqttQos) {
  requireNative();
  const result = await requestNativePayload<{ snapshot: MqttSessionSnapshot }>(
    'mqtt.subscribe', { topic, qos },
  );
  return result.snapshot;
}

export async function requestMqttUnsubscribe(topic: string) {
  requireNative();
  const result = await requestNativePayload<{ snapshot: MqttSessionSnapshot }>(
    'mqtt.unsubscribe', { topic },
  );
  return result.snapshot;
}

export async function requestMqttPublish(
  topic: string,
  dataHex: string,
  qos: MqttQos,
  retain: boolean,
) {
  requireNative();
  const result = await requestNativePayload<{ snapshot: MqttSessionSnapshot }>(
    'mqtt.publish', { topic, dataHex, qos, retain },
  );
  return result.snapshot;
}

export { isNativeHost };
