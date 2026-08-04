'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { RunnableToolId } from '../../../lib/runnableTools'
import * as wasm from '../../../lib/wasmNative'
import styles from './ToolRunner.module.scss'

// Web runners mirror the desktop utility plugins, but call wasmNative directly
// so the static Next site can demonstrate core tools without a desktop host.
type CopyState = 'idle' | 'copied' | 'failed'
type Base = 'bin' | 'oct' | 'dec' | 'hex'

const BASES: Base[] = ['bin', 'oct', 'dec', 'hex']
const BASE_NUM: Record<Base, number> = { bin: 2, oct: 8, dec: 10, hex: 16 }
const BASE_META: Record<Base, { label: string; sub: string }> = {
  bin: { label: 'BIN', sub: 'base 2' },
  oct: { label: 'OCT', sub: 'base 8' },
  dec: { label: 'DEC', sub: 'base 10' },
  hex: { label: 'HEX', sub: 'base 16' },
}

interface ToolRunnerProps {
  toolId: RunnableToolId
}

export function ToolRunner({ toolId }: ToolRunnerProps) {
  // Keep this dispatch explicit. Each tool has small state and specialized UI,
  // so a registry abstraction would hide more than it helps here.
  if (toolId === 'hash') return <HashRunner />
  if (toolId === 'base64') return <Base64Runner />
  if (toolId === 'hex') return <HexRunner />
  if (toolId === 'url-encode') return <UrlEncodeRunner />
  if (toolId === 'uuid') return <UuidRunner />
  if (toolId === 'password') return <PasswordRunner />
  if (toolId === 'timestamp') return <TimestampRunner />
  if (toolId === 'numfmt') return <NumberFormatRunner />
  if (toolId === 'json-format') return <JsonRunner />
  if (toolId === 'jwt') return <JwtRunner />
  if (toolId === 'regex') return <RegexRunner />
  if (toolId === 'diff') return <DiffRunner />
  return null
}

function HashRunner() {
  const [input, setInput] = useState('Hello, world!')
  const [md5Value, setMd5Value] = useState('')
  const [shaValue, setShaValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    // Avoid updating state from a slower async WASM result after the input has
    // changed or the runner has unmounted.
    ;(async () => {
      try {
        const [nextMd5, nextSha] = await Promise.all([wasm.md5(input), wasm.sha256(input)])
        if (!alive) return
        setMd5Value(nextMd5)
        setShaValue(nextSha)
        setError(null)
      } catch (err) {
        if (!alive) return
        setMd5Value('')
        setShaValue('')
        setError(err instanceof Error ? err.message : 'Hash failed')
      }
    })()
    return () => {
      alive = false
    }
  }, [input])

  return (
    <div className={styles.tool}>
      {error && <ErrorBanner message={error} />}
      <InputCard label="Input" value={input} onChange={setInput} />
      <div className={styles.twoGrid}>
        <OutputCard label="MD5" sub="128 bit" value={md5Value} />
        <OutputCard label="SHA-256" sub="256 bit" value={shaValue} />
      </div>
    </div>
  )
}

function Base64Runner() {
  const [direction, setDirection] = useState<'encode' | 'decode'>('encode')
  const [urlSafe, setUrlSafe] = useState(false)
  const [input, setInput] = useState('Hello, world!')
  const [output, setOutput] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    if (!input) {
      setOutput('')
      setError(null)
      return
    }
    ;(async () => {
      try {
        const result =
          direction === 'encode'
            ? await wasm.base64Encode(input, { urlSafe })
            : await wasm.base64Decode(input)
        if (!alive) return
        setOutput(result)
        setError(null)
      } catch (err) {
        if (!alive) return
        setOutput('')
        setError(err instanceof Error ? err.message : 'Base64 failed')
      }
    })()
    return () => {
      alive = false
    }
  }, [direction, input, urlSafe])

  return (
    <div className={styles.tool}>
      <div className={styles.controlRow}>
        <SegmentButton active={direction === 'encode'} onClick={() => setDirection('encode')}>
          Encode
        </SegmentButton>
        <SegmentButton active={direction === 'decode'} onClick={() => setDirection('decode')}>
          Decode
        </SegmentButton>
        {direction === 'encode' && (
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={urlSafe}
              onChange={(event) => setUrlSafe(event.target.checked)}
            />
            URL-safe
          </label>
        )}
      </div>
      {error && <ErrorBanner message={error} />}
      <InputCard
        label={direction === 'encode' ? 'Plain text' : 'Base64'}
        value={input}
        onChange={setInput}
      />
      <OutputCard
        label={direction === 'encode' ? 'Base64' : 'Plain text'}
        sub={direction === 'encode' && urlSafe ? 'URL-safe' : undefined}
        value={output}
      />
    </div>
  )
}

function HexRunner() {
  const [mode, setMode] = useState<'bytes' | 'number'>('bytes')

  return (
    <div className={styles.tool}>
      <div className={styles.modeSwitch} role="tablist" aria-label="Hex mode">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'bytes'}
          className={`${styles.modeButton} ${mode === 'bytes' ? styles.modeButtonActive : ''}`}
          onClick={() => setMode('bytes')}
        >
          Text bytes
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'number'}
          className={`${styles.modeButton} ${mode === 'number' ? styles.modeButtonActive : ''}`}
          onClick={() => setMode('number')}
        >
          Number base
        </button>
      </div>
      {mode === 'bytes' ? <HexBytesRunner /> : <HexNumberRunner />}
    </div>
  )
}

function HexBytesRunner() {
  const [source, setSource] = useState<'text' | 'hex'>('text')
  const [text, setText] = useState('Unknow')
  const [hex, setHex] = useState('')
  const [binary, setBinary] = useState('')
  const [decimal, setDecimal] = useState('')
  const [octal, setOctal] = useState('')
  const [error, setError] = useState<string | null>(null)
  const input = source === 'text' ? text : hex

  useEffect(() => {
    let alive = true
    if (!input) {
      if (source === 'text') setHex('')
      if (source === 'hex') setText('')
      setBinary('')
      setDecimal('')
      setOctal('')
      setError(null)
      return
    }
    ;(async () => {
      try {
        const normalizedHex =
          source === 'text' ? await wasm.hexEncode(text) : normalizeHexBytes(hex)
        const nextText = source === 'hex' ? await wasm.hexDecode(normalizedHex) : text
        if (!alive) return
        setText(nextText)
        if (source === 'text') setHex(normalizedHex)
        setBinary(formatBinaryBytes(normalizedHex))
        setDecimal(formatByteList(normalizedHex, 10, 1))
        setOctal(formatByteList(normalizedHex, 8, 3))
        setError(null)
      } catch (err) {
        if (!alive) return
        if (source === 'hex') setText('')
        setBinary('')
        setDecimal('')
        setOctal('')
        setError(err instanceof Error ? err.message : 'Invalid bytes')
      }
    })()
    return () => {
      alive = false
    }
  }, [hex, input, source, text])

  const normalizedForCopy = useMemo(() => normalizeHexBytesSafe(hex), [hex])
  const displayHex = source === 'hex' ? hex : formatHexBytes(normalizedForCopy)

  return (
    <>
      {error && <ErrorBanner message={error} />}
      <InputCard
        label="TEXT"
        sub="UTF-8"
        value={text}
        onChange={(value) => {
          setSource('text')
          setText(value)
        }}
      />
      <InputCard
        label="HEX"
        sub="bytes"
        value={displayHex}
        onChange={(value) => {
          setSource('hex')
          setHex(value)
        }}
      />
      <OutputCard label="BIN" sub="bytes" value={binary} />
      <div className={styles.twoGrid}>
        <OutputCard label="DEC" sub="bytes" value={decimal} />
        <OutputCard label="OCT" sub="bytes" value={octal} />
      </div>
    </>
  )
}

function HexNumberRunner() {
  const [values, setValues] = useState<Record<Base, string>>({
    bin: '101010',
    oct: '52',
    dec: '42',
    hex: '2a',
  })
  const [source, setSource] = useState<Base>('dec')
  const [error, setError] = useState<string | null>(null)
  const sourceValue = values[source]

  useEffect(() => {
    let alive = true
    const input = sourceValue.trim()
    if (!input) {
      setValues({ bin: '', oct: '', dec: '', hex: '' })
      setError(null)
      return
    }
    ;(async () => {
      try {
        const next: Record<Base, string> = { bin: '', oct: '', dec: '', hex: '' }
        next[source] = sourceValue
        for (const base of BASES) {
          if (base === source) continue
          next[base] = await wasm.intConvert(input, BASE_NUM[source], BASE_NUM[base])
        }
        if (!alive) return
        setValues(next)
        setError(null)
      } catch (err) {
        if (!alive) return
        setValues((current) => ({ ...current, ...emptyOtherBases(source) }))
        setError(err instanceof Error ? err.message : 'Invalid number')
      }
    })()
    return () => {
      alive = false
    }
  }, [source, sourceValue])

  return (
    <>
      {error && <ErrorBanner message={error} />}
      {BASES.map((base) => {
        const value =
          source === base ? values[base] : groupFromRight(values[base], base === 'oct' ? 3 : 4)
        return (
          <InputCard
            key={base}
            label={BASE_META[base].label}
            sub={BASE_META[base].sub}
            value={value}
            readOnly={source !== base}
            onChange={(nextValue) => {
              setSource(base)
              setValues((current) => ({ ...current, [base]: nextValue }))
            }}
          />
        )
      })}
    </>
  )
}

function UrlEncodeRunner() {
  const [direction, setDirection] = useState<'encode' | 'decode'>('encode')
  const [mode, setMode] = useState<'component' | 'uri'>('component')
  const [input, setInput] = useState('https://example.com/path?key=hello world&q=cafe')
  const [output, setOutput] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    if (!input) {
      setOutput('')
      setError(null)
      return
    }
    ;(async () => {
      try {
        const result =
          direction === 'encode'
            ? await wasm.urlEncode(input, { component: mode === 'component' })
            : await wasm.urlDecode(input)
        if (!alive) return
        setOutput(result)
        setError(null)
      } catch (err) {
        if (!alive) return
        setOutput('')
        setError(err instanceof Error ? err.message : 'URL encode failed')
      }
    })()
    return () => {
      alive = false
    }
  }, [direction, input, mode])

  return (
    <div className={styles.tool}>
      <div className={styles.controlRow}>
        <SegmentButton active={direction === 'encode'} onClick={() => setDirection('encode')}>
          Encode
        </SegmentButton>
        <SegmentButton active={direction === 'decode'} onClick={() => setDirection('decode')}>
          Decode
        </SegmentButton>
        <span className={styles.modeLabel}>Mode</span>
        <SegmentButton active={mode === 'component'} onClick={() => setMode('component')}>
          component
        </SegmentButton>
        <SegmentButton active={mode === 'uri'} onClick={() => setMode('uri')}>
          URI
        </SegmentButton>
      </div>
      {error && <ErrorBanner message={error} />}
      <InputCard
        label={direction === 'encode' ? 'Plain text' : 'Encoded URL'}
        value={input}
        onChange={setInput}
      />
      <OutputCard
        label={direction === 'encode' ? 'Encoded' : 'Decoded'}
        sub={mode}
        value={output}
      />
    </div>
  )
}

function UuidRunner() {
  const [version, setVersion] = useState<'v4' | 'v7'>('v7')
  const [nonce, setNonce] = useState(0)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const next = version === 'v4' ? await wasm.uuidV4() : await wasm.uuidV7()
        if (!alive) return
        setValue(next)
        setError(null)
      } catch (err) {
        if (!alive) return
        setValue('')
        setError(err instanceof Error ? err.message : 'UUID generation failed')
      }
    })()
    return () => {
      alive = false
    }
  }, [nonce, version])

  return (
    <div className={styles.tool}>
      <div className={styles.controlRow}>
        <SegmentButton active={version === 'v7'} onClick={() => setVersion('v7')}>
          v7
        </SegmentButton>
        <SegmentButton active={version === 'v4'} onClick={() => setVersion('v4')}>
          v4
        </SegmentButton>
        <button
          type="button"
          className={styles.copyButton}
          onClick={() => setNonce((current) => current + 1)}
        >
          Generate
        </button>
      </div>
      {error && <ErrorBanner message={error} />}
      <OutputCard label="UUID" sub={version} value={value} />
    </div>
  )
}

function PasswordRunner() {
  const [length, setLength] = useState(24)
  const [lower, setLower] = useState(true)
  const [upper, setUpper] = useState(true)
  const [digits, setDigits] = useState(true)
  const [symbols, setSymbols] = useState(false)
  const [nonce, setNonce] = useState(0)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const safeLength = Math.min(128, Math.max(4, Math.trunc(length || 0)))
        const next = await wasm.passwordGenerate({
          length: safeLength,
          lower,
          upper,
          digits,
          symbols,
        })
        if (!alive) return
        setValue(next)
        setError(null)
      } catch (err) {
        if (!alive) return
        setValue('')
        setError(err instanceof Error ? err.message : 'Password generation failed')
      }
    })()
    return () => {
      alive = false
    }
  }, [digits, length, lower, nonce, symbols, upper])

  return (
    <div className={styles.tool}>
      <div className={styles.inlineControls}>
        <label className={styles.field}>
          <span>Length</span>
          <input
            className={styles.numberInput}
            type="number"
            min={4}
            max={128}
            value={length}
            onChange={(event) => setLength(Number(event.target.value))}
          />
        </label>
        <Toggle checked={lower} onChange={setLower} label="lower" />
        <Toggle checked={upper} onChange={setUpper} label="upper" />
        <Toggle checked={digits} onChange={setDigits} label="digits" />
        <Toggle checked={symbols} onChange={setSymbols} label="symbols" />
        <button
          type="button"
          className={styles.copyButton}
          onClick={() => setNonce((current) => current + 1)}
        >
          Generate
        </button>
      </div>
      {error && <ErrorBanner message={error} />}
      <OutputCard label="PASSWORD" sub="crypto random" value={value} />
    </div>
  )
}

function TimestampRunner() {
  const [source, setSource] = useState<'milliseconds' | 'seconds' | 'iso'>('milliseconds')
  const [input, setInput] = useState(() => String(Date.now()))
  const [iso, setIso] = useState('')
  const [seconds, setSeconds] = useState('')
  const [milliseconds, setMilliseconds] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    if (!input.trim()) {
      setIso('')
      setSeconds('')
      setMilliseconds('')
      setError(null)
      return
    }
    ;(async () => {
      try {
        if (source === 'iso') {
          const ms = Date.parse(input)
          if (!Number.isFinite(ms)) throw new Error('Invalid ISO timestamp')
          if (!alive) return
          setIso(new Date(ms).toISOString())
          setSeconds(String(Math.trunc(ms / 1000)))
          setMilliseconds(String(ms))
          setError(null)
          return
        }

        const numeric = parseInteger(input)
        const nextIso = await wasm.timestampToIso(numeric, source)
        const ms = source === 'seconds' ? numeric * 1000n : numeric
        if (!alive) return
        setIso(nextIso)
        setSeconds((ms / 1000n).toString())
        setMilliseconds(ms.toString())
        setError(null)
      } catch (err) {
        if (!alive) return
        setIso('')
        setSeconds('')
        setMilliseconds('')
        setError(err instanceof Error ? err.message : 'Timestamp conversion failed')
      }
    })()
    return () => {
      alive = false
    }
  }, [input, source])

  return (
    <div className={styles.tool}>
      <div className={styles.controlRow}>
        <SegmentButton active={source === 'milliseconds'} onClick={() => setSource('milliseconds')}>
          millis
        </SegmentButton>
        <SegmentButton active={source === 'seconds'} onClick={() => setSource('seconds')}>
          seconds
        </SegmentButton>
        <SegmentButton active={source === 'iso'} onClick={() => setSource('iso')}>
          ISO
        </SegmentButton>
        <button
          type="button"
          className={styles.copyButton}
          onClick={() => {
            setSource('milliseconds')
            setInput(String(Date.now()))
          }}
        >
          Now
        </button>
      </div>
      {error && <ErrorBanner message={error} />}
      <InputCard label="INPUT" sub={source} value={input} onChange={setInput} />
      <OutputCard label="ISO 8601" value={iso} />
      <div className={styles.twoGrid}>
        <OutputCard label="SECONDS" value={seconds} />
        <OutputCard label="MILLISECONDS" value={milliseconds} />
      </div>
    </div>
  )
}

function NumberFormatRunner() {
  const [input, setInput] = useState('1234567890.42')
  const [output, setOutput] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    if (!input.trim()) {
      setOutput('')
      setError(null)
      return
    }
    ;(async () => {
      try {
        const next = await wasm.numberGroup(input)
        if (!alive) return
        setOutput(next)
        setError(null)
      } catch (err) {
        if (!alive) return
        setOutput('')
        setError(err instanceof Error ? err.message : 'Number formatting failed')
      }
    })()
    return () => {
      alive = false
    }
  }, [input])

  return (
    <div className={styles.tool}>
      {error && <ErrorBanner message={error} />}
      <InputCard label="NUMBER" value={input} onChange={setInput} />
      <OutputCard label="FORMATTED" value={output} />
    </div>
  )
}

function JsonRunner() {
  const [mode, setMode] = useState<'format' | 'minify'>('format')
  const [input, setInput] = useState(
    '{"name":"可爱依依 · CloudYi","local":true,"tools":["json","wasm"]}',
  )
  const [output, setOutput] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    try {
      const parsed = JSON.parse(input)
      setOutput(mode === 'format' ? JSON.stringify(parsed, null, 2) : JSON.stringify(parsed))
      setError(null)
    } catch (err) {
      setOutput('')
      setError(err instanceof Error ? err.message : 'Invalid JSON')
    }
  }, [input, mode])

  return (
    <div className={styles.tool}>
      <div className={styles.controlRow}>
        <SegmentButton active={mode === 'format'} onClick={() => setMode('format')}>
          Beautify
        </SegmentButton>
        <SegmentButton active={mode === 'minify'} onClick={() => setMode('minify')}>
          Minify
        </SegmentButton>
      </div>
      {error && <ErrorBanner message={error} />}
      <InputCard label="JSON" value={input} onChange={setInput} />
      <OutputCard label={mode === 'format' ? 'BEAUTIFIED' : 'MINIFIED'} value={output} />
    </div>
  )
}

function JwtRunner() {
  const [token, setToken] = useState(
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  )
  const [secret, setSecret] = useState('your-256-bit-secret')
  const [header, setHeader] = useState('')
  const [payload, setPayload] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const parts = token.trim().split('.')
        if (parts.length !== 3) throw new Error('JWT must have header, payload, and signature')
        const [encodedHeader, encodedPayload, signature] = parts as [string, string, string]
        const decodedHeader = decodeBase64UrlJson(encodedHeader)
        const decodedPayload = decodeBase64UrlJson(encodedPayload)
        const alg = readJsonAlg(decodedHeader)
        const verified =
          alg === 'HS256' && secret
            ? await verifyHs256(`${encodedHeader}.${encodedPayload}`, signature, secret)
            : null
        if (!alive) return
        setHeader(decodedHeader)
        setPayload(decodedPayload)
        setStatus(
          verified === null
            ? `alg: ${alg || 'unknown'} / verification not available for this algorithm`
            : verified
              ? 'HS256 signature verified'
              : 'HS256 signature does not match',
        )
        setError(null)
      } catch (err) {
        if (!alive) return
        setHeader('')
        setPayload('')
        setStatus('')
        setError(err instanceof Error ? err.message : 'JWT decode failed')
      }
    })()
    return () => {
      alive = false
    }
  }, [secret, token])

  return (
    <div className={styles.tool}>
      {error && <ErrorBanner message={error} />}
      <InputCard label="JWT" value={token} onChange={setToken} />
      <InputCard label="HS256 SECRET" value={secret} onChange={setSecret} />
      <OutputCard label="HEADER" value={header} />
      <OutputCard label="PAYLOAD" value={payload} />
      <OutputCard label="SIGNATURE" value={status} />
    </div>
  )
}

function RegexRunner() {
  const [pattern, setPattern] = useState('\\b\\w{5}\\b')
  const [flags, setFlags] = useState('gi')
  const [sample, setSample] = useState(
    'CloudYiCFAW keeps local tools fast, searchable, and portable.',
  )
  const [output, setOutput] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    try {
      const nextFlags = flags.includes('g') ? flags : `${flags}g`
      const regex = new RegExp(pattern, nextFlags)
      const matches = Array.from(sample.matchAll(regex)).map((match) => ({
        match: match[0],
        index: match.index ?? 0,
        groups: match.slice(1),
      }))
      setOutput(matches.length ? JSON.stringify(matches, null, 2) : 'No matches')
      setError(null)
    } catch (err) {
      setOutput('')
      setError(err instanceof Error ? err.message : 'Invalid regular expression')
    }
  }, [flags, pattern, sample])

  return (
    <div className={styles.tool}>
      {error && <ErrorBanner message={error} />}
      <div className={styles.twoGrid}>
        <InputCard label="PATTERN" value={pattern} onChange={setPattern} />
        <InputCard label="FLAGS" value={flags} onChange={setFlags} />
      </div>
      <InputCard label="TEXT" value={sample} onChange={setSample} />
      <OutputCard label="MATCHES" value={output} />
    </div>
  )
}

function DiffRunner() {
  const [left, setLeft] = useState('CloudYiCFAW\nlocal tools\nsigned plugins')
  const [right, setRight] = useState('CloudYiCFAW\nbrowser tools\nsigned plugins')
  const diff = useMemo(() => buildLineDiff(left, right), [left, right])

  return (
    <div className={styles.tool}>
      <div className={styles.twoGrid}>
        <InputCard label="LEFT" value={left} onChange={setLeft} />
        <InputCard label="RIGHT" value={right} onChange={setRight} />
      </div>
      <OutputCard label="DIFF" value={diff} />
    </div>
  )
}

function InputCard(props: {
  label: string
  sub?: string
  value: string
  readOnly?: boolean
  onChange?: (value: string) => void
}) {
  const { label, sub, value, readOnly, onChange } = props
  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <div className={styles.cardLabel}>
          <span className={styles.algorithm}>{label}</span>
          {sub && <span className={styles.bits}>{sub}</span>}
        </div>
        <CopyButton value={value} />
      </div>
      <textarea
        className={styles.textarea}
        value={value}
        readOnly={readOnly}
        rows={3}
        onChange={(event) => onChange?.(event.target.value)}
      />
    </div>
  )
}

function OutputCard(props: { label: string; sub?: string; value: string }) {
  const { label, sub, value } = props
  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <div className={styles.cardLabel}>
          <span className={styles.algorithm}>{label}</span>
          {sub && <span className={styles.bits}>{sub}</span>}
        </div>
        <CopyButton value={value} />
      </div>
      <code className={styles.code}>{value || <span className={styles.placeholder}>-</span>}</code>
    </div>
  )
}

function CopyButton({ value }: { value: string }) {
  const [state, setState] = useState<CopyState>('idle')

  const copy = async () => {
    if (!value) return
    try {
      await wasm.copyText(value)
      setState('copied')
    } catch {
      setState('failed')
    }
    setTimeout(() => setState('idle'), 1500)
  }

  return (
    <button type="button" className={styles.copyButton} onClick={copy} disabled={!value}>
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Failed' : 'Copy'}
    </button>
  )
}

function SegmentButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className={`${styles.segmentButton} ${active ? styles.segmentButtonActive : ''}`}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
}) {
  return (
    <label className={styles.check}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  )
}

function ErrorBanner({ message }: { message: string }) {
  return <div className={styles.errorBanner}>{message}</div>
}

function normalizeHexBytes(value: string): string {
  const stripped = value
    .replace(/0x/gi, '')
    .replace(/[\s,_:-]/g, '')
    .trim()

  if (stripped.length % 2 !== 0) {
    throw new Error('hex bytes need an even number of digits')
  }
  if (!/^[0-9a-f]*$/i.test(stripped)) {
    throw new Error('hex bytes may only contain 0-9 and A-F')
  }
  return stripped.toLowerCase()
}

function normalizeHexBytesSafe(value: string): string {
  try {
    return normalizeHexBytes(value)
  } catch {
    return ''
  }
}

function bytesFromHex(hex: string): number[] {
  const bytes: number[] = []
  for (let index = 0; index < hex.length; index += 2) {
    bytes.push(Number.parseInt(hex.slice(index, index + 2), 16))
  }
  return bytes
}

function formatHexBytes(hex: string): string {
  return bytesFromHex(hex)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join(' ')
}

function formatBinaryBytes(hex: string): string {
  return bytesFromHex(hex)
    .map((byte) => byte.toString(2).padStart(8, '0'))
    .join(' ')
}

function formatByteList(hex: string, base: number, width: number): string {
  return bytesFromHex(hex)
    .map((byte) => byte.toString(base).padStart(width, '0'))
    .join(' ')
}

function groupFromRight(value: string, size: number): string {
  if (!value) return value
  const out: string[] = []
  for (let index = value.length; index > 0; index -= size) {
    out.unshift(value.slice(Math.max(0, index - size), index))
  }
  return out.join(' ')
}

function emptyOtherBases(source: Base): Partial<Record<Base, string>> {
  const next: Partial<Record<Base, string>> = {}
  for (const base of BASES) {
    if (base !== source) next[base] = ''
  }
  return next
}

function parseInteger(value: string): bigint {
  const cleaned = value.trim().replace(/[_\s,]/g, '')
  if (!/^-?\d+$/.test(cleaned)) throw new Error('Expected an integer value')
  return BigInt(cleaned)
}

function decodeBase64Url(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return new TextDecoder().decode(bytes)
}

function decodeBase64UrlJson(input: string): string {
  return JSON.stringify(JSON.parse(decodeBase64Url(input)), null, 2)
}

function readJsonAlg(json: string): string {
  const parsed = JSON.parse(json) as { alg?: unknown }
  return typeof parsed.alg === 'string' ? parsed.alg : ''
}

async function verifyHs256(
  signingInput: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput))
  return base64UrlEncode(new Uint8Array(signed)) === signature
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function buildLineDiff(left: string, right: string): string {
  const leftLines = left.split(/\r?\n/)
  const rightLines = right.split(/\r?\n/)
  const max = Math.max(leftLines.length, rightLines.length)
  const lines: string[] = []

  for (let index = 0; index < max; index += 1) {
    const a = leftLines[index]
    const b = rightLines[index]
    if (a === b) {
      lines.push(`  ${a ?? ''}`)
    } else {
      if (a !== undefined) lines.push(`- ${a}`)
      if (b !== undefined) lines.push(`+ ${b}`)
    }
  }

  return lines.join('\n')
}
