/** Prevent desktop confirmation dialogs from silently diverging again. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const files = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const name = path.join(directory, entry.name);
  return entry.isDirectory() ? files(name) : /\.(?:tsx?|scss)$/.test(name) ? [name] : [];
});
const sourceFiles = [...files(path.join(root, 'frontend/src')), ...files(path.join(root, 'shared'))];
for (const file of sourceFiles) {
  const text = fs.readFileSync(file, 'utf8');
  const relative = path.relative(root, file).replaceAll('\\', '/');
  assert.doesNotMatch(text, /\b(?:window\s*\.\s*)?(?:confirm|alert|prompt)\s*\(/, `${relative}: use the shared desktop dialog instead of browser prompts`);
  if (relative !== 'frontend/src/components/ConfirmDialog.tsx') {
    assert.doesNotMatch(text, /<dialog\b|\.showModal\s*\(/, `${relative}: modal chrome belongs to ConfirmDialog`);
  }
  if (relative !== 'frontend/src/pet/Pet.tsx') {
    assert.doesNotMatch(text, /role\s*=\s*["']dialog["']|modalBackdrop/, `${relative}: no separate hand-built modal`);
  }
}
for (const relative of ['dashboard/Dashboard.tsx', 'toolbox/DatabaseStudio.tsx', 'toolbox/ModbusDebugger.tsx', 'toolbox/SoftwareUninstaller.tsx', 'toolbox/PortManagerWorkspace.tsx']) {
  assert.match(fs.readFileSync(path.join(root, 'frontend/src', relative), 'utf8'), /<ConfirmDialog\b/, `${relative}: uses shared confirmation`);
}
// Pet speech bubbles are non-modal interactions; OS file pickers/startup errors have no WebView equivalent.
console.log(`PASS dialog inventory: ${sourceFiles.length} source files checked; all desktop confirmations share one component, no browser-native prompts or old modal shells.`);
