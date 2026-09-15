import { useEffect, useRef, useState } from 'react';
import { convertPacketPayloadMode, encodeNetworkPayload, packetNetworkMode, type PacketSenderDraft } from './packetSenderModel';
import styles from './PacketTemplateDialog.module.scss';

/** A detached copy: editing, cancelling and saving never mutate a live session or send draft. */
export function PacketTemplateEditor({ initial, editing, busy, onSave, onCancel }: {
  initial: PacketSenderDraft; editing: boolean; busy: boolean;
  onSave(draft: PacketSenderDraft): void; onCancel(): void;
}) {
  const [draft, setDraft] = useState(() => ({ ...initial }));
  const [error, setError] = useState('');
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => { nameInput.current?.focus({ preventScroll: true }); }, []);
  const edit = <K extends keyof PacketSenderDraft>(key: K, value: PacketSenderDraft[K]) => { setDraft((old) => ({ ...old, [key]: value })); setError(''); };
  const mode = packetNetworkMode(draft);
  let byteCount = 0, payloadError = '';
  try { byteCount = encodeNetworkPayload(draft).byteCount; } catch (e) { payloadError = e instanceof Error ? e.message : '报文内容无效。'; }
  return <form className={styles.editor} aria-label={editing ? '编辑报文模板' : '新建报文模板'} onSubmit={(event) => { event.preventDefault(); onSave({ ...draft }); }}>
    <div className={styles.editorScroll}>
      <h3>{editing ? '编辑模板' : '新建模板'}</h3>
      <label>模板名称<input ref={nameInput} data-template-autofocus aria-label="模板名称" maxLength={80} value={draft.name} disabled={busy} onChange={(event) => edit('name', event.target.value)} /></label>
      <div className={styles.editorGrid}>
        <label>网络模式<select aria-label="模板网络模式" disabled={busy} value={mode} onChange={(event) => { const networkMode = event.target.value as PacketSenderDraft['networkMode']; setDraft((old) => ({ ...old, networkMode, protocol: networkMode === 'udp' ? 'udp' : 'tcp' })); setError(''); }}><option value="tcp-client">TCP 客户端</option><option value="tcp-server">TCP 服务端</option><option value="udp">UDP</option></select></label>
        <label>行尾<select aria-label="模板行尾" disabled={busy} value={draft.lineEnding ?? 'none'} onChange={(event) => edit('lineEnding', event.target.value as PacketSenderDraft['lineEnding'])}><option value="none">不添加</option><option value="lf">LF</option><option value="crlf">CRLF</option></select></label>
        {mode !== 'tcp-server' && <><label>目标地址<input aria-label="模板目标地址" value={draft.host} maxLength={253} disabled={busy} onChange={(event) => edit('host', event.target.value)} /></label><label>目标端口<input aria-label="模板目标端口" type="number" value={draft.port} disabled={busy} onChange={(event) => edit('port', Number(event.target.value))} /></label></>}
      </div>
      <div className={styles.editorPayloadToolbar}><label>内容格式<select aria-label="模板内容格式" value={draft.dataMode} disabled={busy} onChange={(event) => { const dataMode = event.target.value as PacketSenderDraft['dataMode']; try { const payload = convertPacketPayloadMode(draft, dataMode); setDraft({ ...draft, dataMode, payload }); setError(''); } catch (e) { setError(e instanceof Error ? e.message : '无法转换，原内容已保留。'); } }}><option value="text">文本</option><option value="hex">HEX</option><option value="escaped">转义字节</option></select></label><span>{byteCount} 字节</span></div>
      <label>报文内容<textarea aria-label="模板报文内容" spellCheck={false} value={draft.payload} disabled={busy} onChange={(event) => edit('payload', event.target.value)} /></label>
      {(error || payloadError) && <p className={styles.editorError} role="alert">{error || payloadError}</p>}
      <details className={styles.advanced} open={mode === 'tcp-server' ? true : undefined}><summary>本地绑定与重复发送参数</summary><div className={styles.editorGrid}>
        <label>本地 IPv4<input aria-label="模板本地 IPv4" value={draft.localAddress} disabled={busy} onChange={(event) => edit('localAddress', event.target.value)} /></label>
        <label>本地端口（0 自动）<input aria-label="模板本地端口" type="number" value={draft.localPort} disabled={busy} onChange={(event) => edit('localPort', Number(event.target.value))} /></label>
        <label>间隔（毫秒）<input aria-label="模板重发间隔" type="number" value={draft.intervalMs} disabled={busy} onChange={(event) => edit('intervalMs', Number(event.target.value))} /></label>
        <label>发送次数<input aria-label="模板重发次数" type="number" value={draft.repeatCount} disabled={busy} onChange={(event) => edit('repeatCount', Number(event.target.value))} /></label>
        {mode === 'udp' && <label>组播 TTL<input aria-label="模板组播 TTL" type="number" value={draft.multicastTtl} disabled={busy} onChange={(event) => edit('multicastTtl', Number(event.target.value))} /></label>}
      </div></details>
    </div>
    <footer className={styles.editorFooter}><span>保存仅更新模板库，发送区保持不变。</span><button type="button" onClick={onCancel}>取消编辑</button><button className={styles.newButton} type="submit" disabled={busy}>保存模板</button></footer>
  </form>;
}
