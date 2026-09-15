/** Packaging/NSIS source contracts and synthetic prerequisite flow only. Never runs an installer or changes the registry. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'installer/CuteYiyiDesktopPet.nsi'), 'utf8');
const standalone = 'MicrosoftEdgeWebView2RuntimeInstallerX64.exe';
const functionBody = (name) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`^Function ${escaped}\\r?\\n([\\s\\S]*?)^FunctionEnd`, 'm'));
  assert.ok(match, `function ${name} exists`);
  return match[1];
};
const prerequisiteBody = source.match(/^Section "-运行环境" SecPrerequisites\r?\n([\s\S]*?)^SectionEnd/m)?.[1];
assert.ok(prerequisiteBody, 'prerequisites execute in their own required section');
assert.ok(source.indexOf('SecPrerequisites') < source.indexOf('SecApplication'), 'prerequisite failures precede app replacement');
assert.ok(prerequisiteBody.includes(`File "/oname=${standalone}" "\${PREREQ_SOURCE}\\${standalone}"`), 'standalone payload is embedded');
assert.ok(prerequisiteBody.includes(`ExecWait '"$PLUGINSDIR\\${standalone}" /silent /install' $1`), 'embedded standalone is installed silently');
assert.match(prerequisiteBody, /vc_redist\.x64\.exe" \/install \/quiet \/norestart/, 'VC++ remains bundled and prevents automatic restart');
assert.doesNotMatch(prerequisiteBody, /MicrosoftEdgeWebView2Setup\.exe|https?:\/\/|inetc::|NSISdl::|检查网络/, 'no bootstrapper, runtime download, or network-dependent failure guidance');
assert.match(prerequisiteBody, /InitPluginsDir\s+SetOutPath "\$PLUGINSDIR"/, 'silent installation initializes its private extraction directory');
for (const name of ['IsVCRuntimeInstalled', 'IsWebView2Installed']) {
  assert.doesNotMatch(functionBody(name), /WriteReg|DeleteReg|Exec|RMDir|Delete /, `${name} is read-only`);
  assert.equal(prerequisiteBody.match(new RegExp(`Call ${name}\\b`, 'g')).length, 2, `${name} is checked before and after installation`);
}
assert.match(functionBody('IsWebView2Installed'), /ReadRegStr \$0 HKLM[\s\S]*ReadRegStr \$0 HKCU/, 'existing machine and per-user runtimes are detected');
assert.match(functionBody('IsWebView2Installed'), /SetRegView 32[\s\S]*SetRegView 64/, 'WebView2 uses documented 32-bit registry view and restores x64 view');
assert.match(functionBody('FailPrerequisite'), /SetErrorLevel 1603[\s\S]*MessageBox[^\n]*\/SD IDOK[\s\S]*Quit/, 'failure exits nonzero without blocking silent deployment');
assert.match(source, /!define MUI_FINISHPAGE_REBOOTLATER_DEFAULT/, 'restart is never the default finish-page action');
assert.doesNotMatch(source, /^\s*!define MUI_FINISHPAGE_NOREBOOTSUPPORT/m, 'MUI reboot mode hides the immediate launch option');
assert.match(source, /!define MUI_FINISHPAGE_TEXT_REBOOT "[^"\n]*重启[^"\n]*再启动/, 'finish page explicitly requires restart before launching');

// Inspect the packaging script as text only: do not execute downloads, signing
// checks, compilation, or installation as part of this isolated regression.
const buildSource = fs.readFileSync(path.join(root, 'scripts/build-installer.ps1'), 'utf8');
const buildCode = buildSource.replace(/<#[\s\S]*?#>/g, '').replace(/^\s*#.*$/gm, '').replace(/`\r?\n\s*/g, ' ');
const buildFunction = (name) => {
  const match = buildCode.match(new RegExp(`^function ${name} \\{([\\s\\S]*?)^\\}`, 'm'));
  assert.ok(match, `packaging function ${name} exists`);
  return match[1];
};
assert.deepEqual([...buildCode.matchAll(/LinkId=(\d+)/g)].map((match) => match[1]), ['2124701'], 'only the official complete x64 WebView2 download endpoint is used');
assert.deepEqual([...new Set(buildCode.match(/MicrosoftEdgeWebView2[A-Za-z0-9]*\.exe/g))], [standalone], 'WebView2 cache references only the standalone filename');
assert.match(buildCode, /Get-Download\s+-Uri 'https:\/\/go\.microsoft\.com\/fwlink\/p\/\?LinkId=2124701'\s+-Destination \$webViewStandalone/, 'official standalone download targets its dedicated cache');
const standaloneValidation = buildFunction('Assert-StandaloneWebView2');
assert.match(standaloneValidation, /\$file = Get-Item -LiteralPath \$Path[\s\S]*\$file\.Name -ne 'MicrosoftEdgeWebView2RuntimeInstallerX64\.exe' -or\s+\$file\.Length -lt 50MB\)\s*\{\s*throw /, 'signed but small bootstrapper payloads are rejected at 50 MB');
assert.match(standaloneValidation, /Assert-MicrosoftSignature -Path \$Path/, 'standalone payload requires Microsoft signature validation');
const signatureValidation = buildFunction('Assert-MicrosoftSignature');
assert.match(signatureValidation, /Get-AuthenticodeSignature -LiteralPath \$Path/, 'signature is read from the actual payload');
assert.match(signatureValidation, /\$signature\.Status -ne 'Valid' -or\s+\$signature\.SignerCertificate\.Subject -notlike '\*Microsoft Corporation\*'\)\s*\{\s*throw /, 'invalid signatures or non-Microsoft signers fail closed');
assert.match(buildCode, /Assert-MicrosoftSignature -Path \$vcRedist\s+Assert-StandaloneWebView2 -Path \$webViewStandalone\s+& \$makensis/, 'both payloads are validated before NSIS compilation, including cached files');
const download = buildFunction('Get-Download');
assert.match(buildCode, /\$ErrorActionPreference = 'Stop'/, 'download errors stop before cache promotion');
assert.match(download, /\$partial = "\$Destination\.partial"\s+Invoke-WebRequest[^\n]*-OutFile \$partial\s+Move-Item -LiteralPath \$partial -Destination \$Destination/, 'download completes to a separate partial file before cache promotion');
assert.doesNotMatch(download, /-OutFile \$Destination\b|-ErrorAction\s+(?:Continue|SilentlyContinue|Ignore)\b/, 'interrupted downloads cannot be mistaken for the final cached payload');
const payloadManifest = buildCode.match(/\$payloads = @\(\$vcRedist, \$webViewStandalone\) \| ForEach-Object \{([\s\S]*?)^    \}/m)?.[1];
assert.ok(payloadManifest, 'integrity manifest contains both actual prerequisite payloads');
assert.match(payloadManifest, /\$file = Get-Item -LiteralPath \$_/, 'manifest reads each payload file');
assert.match(payloadManifest, /file = \$file\.Name\s+size = \$file\.Length\s+sha256 = \(Get-FileHash -LiteralPath \$_ -Algorithm SHA256\)\.Hash/, 'payload names, sizes, and SHA-256 values come from the actual files');
assert.match(buildCode, /\$hash = Get-FileHash -LiteralPath \$installer -Algorithm SHA256/, 'installer hash is computed from the completed binary');
assert.match(buildCode, /offlinePrerequisites = \$true[\s\S]*size = \(Get-Item -LiteralPath \$installer\)\.Length\s+sha256 = \$hash\.Hash/, 'manifest records offline status and actual installer size/hash');
assert.match(buildCode, /prerequisites = @\(\$payloads\)[\s\S]*ConvertTo-Json -Depth 5 \| Set-Content -LiteralPath "\$installer\.manifest\.json" -Encoding UTF8/, 'payload integrity data is persisted alongside the installer');

// Interpret the actual prerequisite section's deliberately small NSIS subset.
// Calls to the two read-only registry detectors and ExecWait are synthetic inputs.
// Unknown instructions fail closed so changes to the NSIS cannot silently evade coverage.
function parse(body) {
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith(';'));
  let index = 0;
  function block() {
    const nodes = [];
    while (index < lines.length && !/^\$\{(?:Else|EndIf)\}$/.test(lines[index])) {
      const line = lines[index++];
      if (line.startsWith('${If} ')) {
        const conditions = [line.slice(6)];
        while (lines[index]?.startsWith('${AndIf} ')) conditions.push(lines[index++].slice(9));
        const yes = block();
        let no = [];
        if (lines[index] === '${Else}') { index++; no = block(); }
        assert.equal(lines[index++], '${EndIf}', 'balanced NSIS conditional');
        nodes.push({ conditions, yes, no });
      } else nodes.push(line);
    }
    return nodes;
  }
  const result = block();
  assert.equal(index, lines.length, 'all instructions were parsed');
  return result;
}
const section = parse(prerequisiteBody);
const failure = parse(functionBody('FailPrerequisite'));
const success = parse(functionBody('.onInstSuccess'));

function simulate(input = {}) {
  const fixtures = Object.fromEntries(['vc', 'webview'].map((kind) => [kind, { before: true, after: true, code: 0, ...input[kind] }]));
  const state = { registers: {}, stack: [], errors: false, reboot: false, exit: 0, stopped: false, installed: [], checked: { vc: 0, webview: 0 }, appMayInstall: false };
  const condition = (text) => {
    if (text === '${Errors}') return state.errors;
    if (text === '${RebootFlag}') return state.reboot;
    const match = text.match(/^(\$\d) (=|!=) (\d+)$/);
    assert.ok(match, `supported test condition: ${text}`);
    const equal = Number(state.registers[match[1]]) === Number(match[3]);
    return match[2] === '=' ? equal : !equal;
  };
  const payloadKind = (line) => {
    if (line.includes('vc_redist.x64.exe')) return 'vc';
    assert.ok(line.includes(standalone), `known offline payload: ${line}`);
    return 'webview';
  };
  function run(nodes) {
    for (const node of nodes) {
      if (state.stopped) return;
      if (typeof node !== 'string') { run(node.conditions.every(condition) ? node.yes : node.no); continue; }
      const line = node;
      if (/^(SectionIn|InitPluginsDir|SetOutPath|DetailPrint|MessageBox)\b/.test(line)) continue;
      if (line === 'ClearErrors') { state.errors = false; continue; }
      if (line === 'Quit') { state.stopped = true; continue; }
      if (line === 'Call FailPrerequisite') { run(failure); continue; }
      if (/^Call Is(?:VCRuntime|WebView2)Installed$/.test(line)) {
        const kind = line.includes('VCRuntime') ? 'vc' : 'webview';
        state.registers.$0 = Number(fixtures[kind][state.checked[kind]++ === 0 ? 'before' : 'after']);
        state.stack.push(state.registers.$0);
        continue;
      }
      if (line.startsWith('Pop ')) { state.registers[line.slice(4)] = state.stack.pop(); continue; }
      if (line.startsWith('File ')) { state.errors = Boolean(fixtures[payloadKind(line)].extractError); continue; }
      if (line.startsWith('ExecWait ')) {
        const kind = payloadKind(line);
        state.installed.push(kind);
        state.errors = Boolean(fixtures[kind].launchError);
        // NSIS does not provide a dependable exit register when launch fails.
        state.registers.$1 = state.errors ? undefined : fixtures[kind].code;
        continue;
      }
      if (line.startsWith('StrCpy $PrerequisiteError ')) { state.message = line.slice('StrCpy $PrerequisiteError '.length); continue; }
      if (line === 'SetRebootFlag true') { state.reboot = true; continue; }
      if (line.startsWith('SetErrorLevel ')) { state.exit = Number(line.slice(14)); continue; }
      assert.fail(`unhandled NSIS instruction: ${line}`);
    }
  }
  run(section);
  state.appMayInstall = !state.stopped;
  if (state.appMayInstall) run(success);
  return state;
}

let cases = 0;
function check(input, expected, message) {
  const state = simulate(input);
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(state[key], value, `${message}: ${key}`);
  cases++;
  return state;
}
check({}, { installed: [], exit: 0, appMayInstall: true, checked: { vc: 1, webview: 1 } }, 'existing runtimes are preserved');
check({ vc: { before: false }, webview: { before: false } }, { installed: ['vc', 'webview'], exit: 0, appMayInstall: true, checked: { vc: 2, webview: 2 } }, 'clean offline install rechecks both runtimes');
for (const kind of ['vc', 'webview']) {
  const input = (values) => ({ [kind]: { before: false, ...values } });
  check(input({}), { installed: [kind], exit: 0, appMayInstall: true }, `${kind}: absent runtime installs alone`);
  check(input({ code: 3010 }), { reboot: true, exit: 3010, appMayInstall: true }, `${kind}: registered but reboot required`);
  check(input({ extractError: true }), { installed: [], exit: 1603, appMayInstall: false }, `${kind}: extraction failure`);
  check(input({ launchError: true }), { exit: 1603, appMayInstall: false }, `${kind}: ExecWait launch failure`);
  check(input({ code: 1603 }), { exit: 1603, appMayInstall: false }, `${kind}: installer reports failure`);
  check(input({ code: 0, after: false }), { exit: 1603, appMayInstall: false }, `${kind}: zero exit without registered runtime is not success`);
  const state = check(input({ code: 3010, after: false }), { exit: 1603, appMayInstall: false }, `${kind}: reboot-pending missing runtime stops incomplete install`);
  assert.match(state.message, /重启后重新运行此离线安装包/, `${kind}: incomplete restart case gives actionable offline guidance`);
}
check({ vc: { before: false, code: 1638, after: true } }, { exit: 0, appMayInstall: true }, 'VC++ existing newer version accepted only after verification');
check({ vc: { before: false, code: 1638, after: false } }, { exit: 1603, appMayInstall: false }, 'VC++ 1638 without detected runtime is not success');
check({ webview: { before: false, code: 1638 } }, { exit: 1603, appMayInstall: false }, 'unexpected WebView2 exit is not accepted');
check({ vc: { before: false, code: 3010 }, webview: { before: false } }, { installed: ['vc', 'webview'], reboot: true, exit: 3010, appMayInstall: true }, 'VC++ reboot state survives later WebView2 success');
check({ vc: { before: false, code: 3010 }, webview: { before: false, code: 1603 } }, { exit: 1603, appMayInstall: false }, 'later prerequisite failure overrides earlier reboot status');

console.log(`PASS offline installer and build-script source contracts plus ${cases} synthetic prerequisite scenarios. No installer launched, registry changed, or real installation/uninstallation performed.`);
