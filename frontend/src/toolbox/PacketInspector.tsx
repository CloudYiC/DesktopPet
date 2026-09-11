import { PacketWorkbench } from '../../../shared/packet-inspector/PacketWorkbench';
import { parseNativeAnalysis, type PacketMode } from './packetParser';
import { executeTool, isNativeHost } from '../bridge/hostBridge';
import type { ToolDefinition } from './catalog';

interface PacketInspectorProps {
  tool: ToolDefinition;
  onBack(): void;
}

/** Keep the C parser behind the desktop bridge; the workbench has no host dependency. */
async function analyzeNative(hex: string, bytes: number[], mode: PacketMode) {
  const output = await executeTool({ toolId: 'packet-inspector', operation: mode, input: hex });
  return parseNativeAnalysis(output, bytes, mode);
}

export function PacketInspector({ tool, onBack }: PacketInspectorProps) {
  return <PacketWorkbench title={tool.name} onBack={onBack} analyze={isNativeHost ? analyzeNative : undefined} />;
}
