'use client'

import { PacketWorkbench } from '../../../../shared/packet-inspector/PacketWorkbench'
import type { PacketAnalysis, PacketMode } from '../../../../shared/packet-inspector/packetParser'
import { inspectPacket } from '../../../lib/packetInspector'

/** Preserve the web parser's existing protocol bounds; only adapt its response shape. */
async function analyzePacket(_hex: string, bytes: number[], mode: PacketMode): Promise<PacketAnalysis> {
  const result = inspectPacket(bytes, mode)
  return {
    ...result,
    warnings: result.warnings.map((warning) => ({ ...warning, offset: warning.offset ?? 0 })),
  }
}

/** Browser adapter: analysis stays local and never imports the desktop native bridge. */
export function PacketInspector() {
  return <PacketWorkbench backHref="/" analyze={analyzePacket} />
}
