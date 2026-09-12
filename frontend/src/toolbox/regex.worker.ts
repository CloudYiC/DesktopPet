import { executeRegex, type RegexInput, type RegexResult } from './regexModel';

export interface RegexWorkerRequest { id: number; input: RegexInput }
export type RegexWorkerReply = { id: number; result: RegexResult } | { id: number; error: string };
interface RegexWorkerScope {
  onmessage: ((event: MessageEvent<RegexWorkerRequest>) => void) | null;
  postMessage(message: RegexWorkerReply): void;
}
const scope = self as unknown as RegexWorkerScope;
scope.onmessage = ({ data }) => {
  try { scope.postMessage({ id: data.id, result: executeRegex(data.input) }); }
  catch (error) { scope.postMessage({ id: data.id, error: error instanceof Error ? error.message : '表达式测试失败。' }); }
};
