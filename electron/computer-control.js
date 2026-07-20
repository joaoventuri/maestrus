'use strict';
// Controle do computador pro Maestrus (estilo JARVIS) — SEM dependências
// pesadas. Usa o que o SO já tem: PowerShell no Windows (System.Drawing +
// Win32 via Add-Type), screencapture/osascript no macOS. Mantém o instalador
// leve (nada de Python/nut-js/binários nativos).
//
// Tools expostas via MCP: screenshot, open, list_windows, focus, uia_tree,
// click_element, set_value, get_text, click, type, key.
// Windows = .NET UIAutomation. macOS = Accessibility API (System Events/JXA),
// requer permissão de Acessibilidade. Mesma capacidade "acha elemento por nome".

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

function runPowerShell(script, { wantStdout = false, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    // Força UTF-8 na saída pra acentos não virarem "�" (Notepad, nomes de
    // elementos, get_text, etc.). -EncodedCommand evita inferno de escape.
    const full = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n' + script;
    const b64 = Buffer.from(full, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64],
      { timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message || '').toString().slice(0, 300)));
        resolve(wantStdout ? String(stdout).trim() : true);
      });
  });
}
function runCmd(cmd, args, { timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || '').toString().slice(0, 300)));
      resolve(String(stdout));
    });
  });
}
// osascript JXA com tradução do erro de permissão de Acessibilidade (Mac pede
// que o app seja autorizado em System Settings → Privacy → Accessibility).
async function runJXA(script, { timeout = 30000 } = {}) {
  try {
    return String(await runCmd('osascript', ['-l', 'JavaScript', '-e', script], { timeout }));
  } catch (err) {
    const m = String((err && err.message) || '');
    if (/assistive|accessibility|-25211|-1719|not allowed|not authorized/i.test(m)) {
      throw new Error('Permissão de Acessibilidade necessária no macOS: System Settings → Privacy & Security → Accessibility → habilite o Maestrus, depois tente de novo.');
    }
    throw err;
  }
}
// Prelúdio JXA compartilhado: acha o processo (por nome/título de janela, ou o
// em foco) e resolve nome/role de um elemento da árvore de Acessibilidade.
const MAC_UIA = `
function getProc(q){
  var se=Application('System Events');
  if(!q){ var f=se.processes.whose({frontmost:true})(); if(f.length) return f[0]; var a0=se.processes(); return a0[0]; }
  var all=se.processes(); var ql=q.toLowerCase();
  for(var i=0;i<all.length;i++){ try{ if(all[i].name().toLowerCase().indexOf(ql)>=0) return all[i]; }catch(e){} }
  for(var i=0;i<all.length;i++){ try{ var ws=all[i].windows(); for(var j=0;j<ws.length;j++){ var nm=ws[j].name(); if(nm&&nm.toLowerCase().indexOf(ql)>=0) return all[i]; } }catch(e){} }
  throw new Error('Janela nao encontrada: '+q);
}
function elName(e){ try{var t=e.title(); if(t) return t;}catch(_){} try{var d=e.description(); if(d) return d;}catch(_){} try{var v=e.value(); if(typeof v==='string'&&v) return v;}catch(_){} return ''; }
`;
const MAC_KEEP_ROLES = ['AXButton','AXTextField','AXTextArea','AXMenuItem','AXMenuButton','AXCheckBox','AXRadioButton','AXLink','AXStaticText','AXComboBox','AXPopUpButton','AXTabButton','AXRow','AXCell','AXMenuBarItem','AXDisclosureTriangle'];

// ─── SCREENSHOT → base64 PNG (todos os monitores) ────────────────────────────
async function screenshot() {
  if (isWin) {
    const ps = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
[Convert]::ToBase64String($ms.ToArray())
`.trim();
    const b64 = await runPowerShell(ps, { wantStdout: true });
    return { base64: b64.replace(/\s/g, '') };
  }
  if (isMac) {
    const tmp = path.join(os.tmpdir(), `mst-shot-${Date.now()}.png`);
    await runCmd('screencapture', ['-x', '-t', 'png', tmp]);
    const b64 = fs.readFileSync(tmp).toString('base64');
    try { fs.unlinkSync(tmp); } catch {}
    return { base64: b64 };
  }
  // Linux: tenta scrot/imagemagick se existir.
  const tmp = path.join(os.tmpdir(), `mst-shot-${Date.now()}.png`);
  try { await runCmd('import', ['-window', 'root', tmp]); }
  catch { await runCmd('scrot', [tmp]); }
  const b64 = fs.readFileSync(tmp).toString('base64');
  try { fs.unlinkSync(tmp); } catch {}
  return { base64: b64 };
}

// ─── CLICK numa coordenada ───────────────────────────────────────────────────
async function click(x, y, button = 'left') {
  x = Math.round(Number(x)); y = Math.round(Number(y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x/y inválidos');
  if (isWin) {
    const down = button === 'right' ? '0x0008' : '0x0002';
    const up = button === 'right' ? '0x0010' : '0x0004';
    const ps = `
Add-Type @"
using System;using System.Runtime.InteropServices;
public class MstM{
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint dw,int e);
}
"@
[MstM]::SetCursorPos(${x}, ${y}); Start-Sleep -Milliseconds 40
[MstM]::mouse_event(${down},0,0,0,0); [MstM]::mouse_event(${up},0,0,0,0)
`.trim();
    await runPowerShell(ps);
    return { ok: true, x, y };
  }
  if (isMac) {
    // JXA + CoreGraphics: clique real em coordenada (sem dep externa).
    const btn = button === 'right' ? 1 : 0;
    const jxa = `ObjC.import('CoreGraphics');
function cl(x,y,b){var d=$.CGEventCreateMouseEvent($(),b===1?3:1,{x:x,y:y},b);$.CGEventPost(0,d);var u=$.CGEventCreateMouseEvent($(),b===1?4:2,{x:x,y:y},b);$.CGEventPost(0,u);}
cl(${x},${y},${btn});`;
    await runCmd('osascript', ['-l', 'JavaScript', '-e', jxa]);
    return { ok: true, x, y };
  }
  throw new Error('click não suportado neste SO');
}

// ─── TYPE texto ──────────────────────────────────────────────────────────────
async function type(text) {
  text = String(text || '');
  if (!text) return { ok: true };
  if (isWin) {
    // SendKeys: escapa os metacaracteres {}()+^%~[]
    const esc = text.replace(/([{}()\[\]+^%~])/g, '{$1}');
    const ps = `Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${Buffer.from(esc, 'utf8').toString('base64')}")))`;
    await runPowerShell(ps);
    return { ok: true };
  }
  if (isMac) {
    const safe = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    await runCmd('osascript', ['-e', `tell application "System Events" to keystroke "${safe}"`]);
    return { ok: true };
  }
  throw new Error('type não suportado neste SO');
}

// ─── KEY (tecla/atalho: "enter", "ctrl+c", "alt+tab"…) ───────────────────────
const WIN_KEYS = { enter: '{ENTER}', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}', space: ' ',
  backspace: '{BACKSPACE}', delete: '{DELETE}', up: '{UP}', down: '{DOWN}', left: '{LEFT}',
  right: '{RIGHT}', home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}' };
const WIN_MOD = { ctrl: '^', control: '^', alt: '%', shift: '+', win: '^{ESC}' };
async function key(combo) {
  combo = String(combo || '').toLowerCase().trim();
  if (!combo) return { ok: true };
  if (isWin) {
    const parts = combo.split('+').map((s) => s.trim());
    let mods = '', base = '';
    for (const p of parts) {
      if (WIN_MOD[p] && p !== 'win') mods += WIN_MOD[p];
      else base = WIN_KEYS[p] || p;
    }
    const ps = `Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("${mods}${base}")`;
    await runPowerShell(ps);
    return { ok: true };
  }
  if (isMac) {
    const parts = combo.split('+').map((s) => s.trim());
    const macMod = { ctrl: 'control', control: 'control', alt: 'option', option: 'option', shift: 'shift', cmd: 'command', win: 'command' };
    const using = parts.filter((p) => macMod[p]).map((p) => macMod[p] + ' down');
    const baseKey = parts.find((p) => !macMod[p]) || '';
    const special = { enter: 'return', esc: 'escape', escape: 'escape' };
    const k = special[baseKey] || baseKey;
    const usingClause = using.length ? ` using {${using.join(', ')}}` : '';
    // keystroke de tecla nomeada usa "key code"? simplificamos: letras via keystroke.
    const script = k.length === 1
      ? `tell application "System Events" to keystroke "${k}"${usingClause}`
      : `tell application "System Events" to key code (get ${macKeyCode(k)})${usingClause}`;
    await runCmd('osascript', ['-e', script]);
    return { ok: true };
  }
  throw new Error('key não suportado neste SO');
}
function macKeyCode(k) {
  const codes = { return: '36', enter: '36', tab: '48', space: '49', delete: '51', escape: '53',
    left: '123', right: '124', down: '125', up: '126' };
  return codes[k] || '36';
}

// ─── OPEN: lança um app/URL/arquivo DIRETO (jeito certo de "abrir X") ────────
// NÃO simula teclado (que cairia na janela com foco = o Maestrus). Usa
// Start-Process (Win, respeita App Paths + protocolos tipo spotify:) com
// fallback pra atalho do Menu Iniciar; `open` no macOS; `xdg-open` no Linux.
async function openApp(target) {
  target = String(target || '').trim();
  if (!target) throw new Error('alvo vazio');
  if (isWin) {
    const tb64 = Buffer.from(target, 'utf8').toString('base64');
    const ps = `
$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${tb64}"))
try { Start-Process $t -ErrorAction Stop; "OK:" + $t }
catch {
  $dirs = @("$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs", "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs")
  $lnk = Get-ChildItem -Path $dirs -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | Where-Object { $_.BaseName -like "*$t*" } | Sort-Object { $_.BaseName.Length } | Select-Object -First 1
  if ($lnk) { Start-Process $lnk.FullName; "OK:" + $lnk.BaseName }
  else { throw "App nao encontrado: $t. Tente o nome exato do programa, o caminho do .exe, ou uma URL." }
}`.trim();
    const out = await runPowerShell(ps, { wantStdout: true });
    return { ok: true, detail: out };
  }
  if (isMac) {
    if (/^[a-z][a-z0-9.+-]*:\/\//i.test(target) || /^\//.test(target)) { await runCmd('open', [target]); return { ok: true }; }
    try { await runCmd('open', ['-a', target]); } catch { await runCmd('open', [target]); }
    return { ok: true };
  }
  try { await runCmd('xdg-open', [target]); } catch { await runCmd(target, []); }
  return { ok: true };
}

// ─── LIST WINDOWS: janelas abertas (pra a IA saber o que existe) ─────────────
async function listWindows() {
  if (isWin) {
    const ps = `Get-Process | Where-Object { $_.MainWindowTitle -ne '' -and $_.MainWindowHandle -ne 0 } | Select-Object @{n='pid';e={$_.Id}}, @{n='app';e={$_.ProcessName}}, @{n='title';e={$_.MainWindowTitle}} | ConvertTo-Json -Compress`;
    const out = await runPowerShell(ps, { wantStdout: true });
    let arr = [];
    try { const j = JSON.parse(out || '[]'); arr = Array.isArray(j) ? j : [j]; } catch {}
    return { windows: arr };
  }
  if (isMac) {
    const jxa = `var se=Application('System Events');var out=[];se.applicationProcesses.where({visible:true})().forEach(function(p){try{var ws=p.windows();ws.forEach(function(w){out.push({app:p.name(),title:w.name()})})}catch(e){}});JSON.stringify(out);`;
    const out = await runCmd('osascript', ['-l', 'JavaScript', '-e', jxa]);
    let arr = []; try { arr = JSON.parse(out || '[]'); } catch {}
    return { windows: arr };
  }
  return { windows: [] };
}

// ─── FOCUS: traz uma janela EXISTENTE pra frente (por título ou app) ─────────
// É o que faltava pra "navegar numa janela já aberta": foca ela ANTES de
// screenshot/click/type (que sempre agem na janela em foco).
async function focusWindow(query) {
  query = String(query || '').trim();
  if (!query) throw new Error('informe o título ou nome do app');
  if (isWin) {
    const qb64 = Buffer.from(query, 'utf8').toString('base64');
    // Enumera as janelas TOP-LEVEL reais (EnumWindows), filtra só as VISÍVEIS e
    // ignora a própria janela do Maestrus (pelo nome do processo). Casa por
    // título OU nome do app. Nunca esconde — só restaura + traz à frente. Isso
    // resolve o "foca a janela errada/invisível e a real some pro fundo".
    const selfPid = process.pid;
    const ps = `
$q = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${qb64}"))
$selfPid = ${selfPid}
Add-Type @"
using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public class MstWin{
 public delegate bool EnumProc(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
 [DllImport("user32.dll")] [return:MarshalAs(UnmanagedType.Bool)] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
 [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
 public static List<IntPtr> Enum(){
  var r = new List<IntPtr>();
  EnumWindows((h,l)=>{ if(IsWindowVisible(h)){ int n=GetWindowTextLength(h); if(n>0) r.Add(h); } return true; }, IntPtr.Zero);
  return r;
 }
}
"@
# Coleta janelas visíveis com título, anexa pid/processo (exceto o Maestrus).
$cands = @()
foreach ($h in [MstWin]::Enum()) {
  $sb = New-Object System.Text.StringBuilder 512
  [void][MstWin]::GetWindowText($h, $sb, 512)
  $title = $sb.ToString()
  [uint32]$pid = 0; [void][MstWin]::GetWindowThreadProcessId($h, [ref]$pid)
  if ($pid -eq $selfPid) { continue }   # nunca foca a própria janela do Maestrus
  $pname = ''
  try { $pname = (Get-Process -Id $pid -ErrorAction Stop).ProcessName } catch {}
  if ($title -like "*$q*" -or $pname -like "*$q*") {
    $cands += [pscustomobject]@{ h=$h; title=$title; pname=$pname; titleMatch=($title -like "*$q*") }
  }
}
if ($cands.Count -eq 0) { throw "Janela visivel nao encontrada: $q" }
# Prefere match no TÍTULO; entre eles, o título mais curto (mais específico).
$best = $cands | Sort-Object @{e={-[int]$_.titleMatch}}, @{e={$_.title.Length}} | Select-Object -First 1
$h = $best.h
if ([MstWin]::IsIconic($h)) { [void][MstWin]::ShowWindow($h, 9) }  # SW_RESTORE
# AttachThreadInput pra furar o foreground-lock do Windows.
$fg = [MstWin]::GetForegroundWindow()
[uint32]$tp = 0
$tFg = [MstWin]::GetWindowThreadProcessId($fg, [ref]$tp)
$tMe = [MstWin]::GetCurrentThreadId()
[void][MstWin]::AttachThreadInput($tMe, $tFg, $true)
[void][MstWin]::ShowWindow($h, 5)   # SW_SHOW (nunca esconde)
[void][MstWin]::SetForegroundWindow($h)
[void][MstWin]::AttachThreadInput($tMe, $tFg, $false)
"OK:" + $best.pname + ":" + $best.title`.trim();
    const out = await runPowerShell(ps, { wantStdout: true });
    return { ok: true, detail: out };
  }
  if (isMac) {
    const safe = query.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    try { await runCmd('osascript', ['-e', `tell application "${safe}" to activate`]); }
    catch { await runCmd('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose name contains "${safe}") to true`]); }
    return { ok: true };
  }
  try { await runCmd('wmctrl', ['-a', query]); return { ok: true }; } catch {}
  throw new Error('focus não suportado neste SO');
}

// ─── UIAutomation (.NET, via PowerShell) — nível JARVIS, SEM Python ──────────
// Acha elementos da interface PELO NOME (botões, campos, menus), clica/preenche
// /lê de verdade — em vez de clicar em coordenada cega. Usa System.Windows.
// Automation, que já vem no Windows. Resolve a janela por título/app (ou a em
// foco) e opera a árvore de UI dela.
function b64(s) { return Buffer.from(String(s ?? ''), 'utf8').toString('base64'); }
function winHandlePS(query) {
  if (!query) {
    return `Add-Type @"
using System;using System.Runtime.InteropServices;
public class MstFG{ [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }
"@
$hwnd = [MstFG]::GetForegroundWindow()`;
  }
  return `$q = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${b64(query)}"))
$proc = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.MainWindowTitle -like "*$q*" -or $_.ProcessName -like "*$q*") } | Sort-Object { $_.MainWindowTitle.Length } | Select-Object -First 1
if (-not $proc) { throw "Janela nao encontrada: $q" }
$hwnd = $proc.MainWindowHandle`;
}
const UIA_PRELUDE = `Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Windows.Forms
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]`;
const KINDS = "@('Button','Edit','Document','Text','MenuItem','MenuBar','CheckBox','RadioButton','Hyperlink','ListItem','TabItem','ComboBox','TreeItem','SplitButton','ToolBar')";

// Lista os elementos interativos da janela (nome + tipo + centro x,y).
async function uiaTree(query) {
  if (isMac) return await macUiaTree(query);
  if (!isWin) throw new Error('UIAutomation só no Windows/macOS');
  const ps = `${UIA_PRELUDE}
${winHandlePS(query)}
$win = $AE::FromHandle([IntPtr]$hwnd)
if (-not $win) { throw "Sem AutomationElement pra essa janela" }
$cond = New-Object System.Windows.Automation.PropertyCondition($AE::IsControlElementProperty, $true)
$els = $win.FindAll($TS::Descendants, $cond)
$keep = ${KINDS}
$out = New-Object System.Collections.ArrayList
foreach ($e in $els) {
  try {
    $ct = $e.Current.ControlType.ProgrammaticName -replace '.*\\.',''
    if ($keep -notcontains $ct) { continue }
    $n = $e.Current.Name
    $r = $e.Current.BoundingRectangle
    if ($r.Width -le 0 -or $r.Height -le 0) { continue }
    if (-not $n -and $ct -ne 'Edit' -and $ct -ne 'Document') { continue }
    [void]$out.Add([pscustomobject]@{ name=$n; type=$ct; x=[int]($r.X + $r.Width/2); y=[int]($r.Y + $r.Height/2); enabled=$e.Current.IsEnabled })
  } catch {}
  if ($out.Count -ge 100) { break }
}
$out | ConvertTo-Json -Compress`;
  const outStr = await runPowerShell(ps, { wantStdout: true, timeout: 30000 });
  let arr = []; try { const j = JSON.parse(outStr || '[]'); arr = Array.isArray(j) ? j : [j]; } catch {}
  return { window: query || '(em foco)', count: arr.length, elements: arr };
}

// Clica num elemento PELO NOME (Invoke real; fallback pro centro do elemento).
async function uiaClickElement(query, name) {
  if (isMac) return await macUiaClickElement(query, name);
  if (!isWin) throw new Error('UIAutomation só no Windows/macOS');
  if (!name) throw new Error('informe o name do elemento');
  const ps = `${UIA_PRELUDE}
Add-Type @"
using System;using System.Runtime.InteropServices;
public class MstC{ [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint dw,int e); }
"@
${winHandlePS(query)}
$name = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${b64(name)}"))
$win = $AE::FromHandle([IntPtr]$hwnd)
$cond = New-Object System.Windows.Automation.PropertyCondition($AE::IsControlElementProperty, $true)
$els = $win.FindAll($TS::Descendants, $cond)
$target = $null
foreach ($e in $els) { try { if ($e.Current.Name -eq $name) { $target = $e; break } } catch {} }
if (-not $target) { foreach ($e in $els) { try { if ($e.Current.Name -like "*$name*") { $target = $e; break } } catch {} } }
if (-not $target) { throw "Elemento nao encontrado: $name" }
$ip = $null
if ($target.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) { $ip.Invoke(); "OK:invoke:" + $target.Current.Name }
else {
  $r = $target.Current.BoundingRectangle
  $cx = [int]($r.X + $r.Width/2); $cy = [int]($r.Y + $r.Height/2)
  try { $target.SetFocus() } catch {}
  [MstC]::SetCursorPos($cx,$cy); Start-Sleep -Milliseconds 40
  [MstC]::mouse_event(0x0002,0,0,0,0); [MstC]::mouse_event(0x0004,0,0,0,0)
  "OK:click:" + $target.Current.Name + ":($cx,$cy)"
}`;
  const out = await runPowerShell(ps, { wantStdout: true, timeout: 30000 });
  return { ok: true, detail: out };
}

// Preenche um campo PELO NOME (ValuePattern; fallback foco + digitação).
async function uiaSetValue(query, name, text) {
  if (isMac) return await macUiaSetValue(query, name, text);
  if (!isWin) throw new Error('UIAutomation só no Windows/macOS');
  const ps = `${UIA_PRELUDE}
${winHandlePS(query)}
$name = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${b64(name)}"))
$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${b64(text)}"))
$win = $AE::FromHandle([IntPtr]$hwnd)
$cond = New-Object System.Windows.Automation.PropertyCondition($AE::IsControlElementProperty, $true)
$els = $win.FindAll($TS::Descendants, $cond)
$target = $null
foreach ($e in $els) { try { if ($e.Current.Name -eq $name -or $e.Current.Name -like "*$name*") { $ctt=$e.Current.ControlType.ProgrammaticName; if ($ctt -match 'Edit|Document|ComboBox') { $target=$e; break } } } catch {} }
if (-not $target -and -not $name) { foreach ($e in $els) { try { if ($e.Current.ControlType.ProgrammaticName -match 'Edit|Document') { $target=$e; break } } catch {} } }
if (-not $target) { throw "Campo nao encontrado: $name" }
$vp = $null
if ($target.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { $vp.SetValue($text); "OK:setvalue:" + $target.Current.Name }
else {
  $target.SetFocus(); Start-Sleep -Milliseconds 80
  [System.Windows.Forms.SendKeys]::SendWait("^a")
  $esc = $text -replace '([+^%~(){}\\[\\]])','{$1}'
  [System.Windows.Forms.SendKeys]::SendWait($esc)
  "OK:typed:" + $target.Current.Name
}`;
  const out = await runPowerShell(ps, { wantStdout: true, timeout: 30000 });
  return { ok: true, detail: out };
}

// Lê o TEXTO/conteúdo da janela (resolve "lê meu Notepad aberto").
async function uiaGetText(query) {
  if (isMac) return await macUiaGetText(query);
  if (!isWin) throw new Error('UIAutomation só no Windows/macOS');
  const ps = `${UIA_PRELUDE}
${winHandlePS(query)}
$win = $AE::FromHandle([IntPtr]$hwnd)
$cond = New-Object System.Windows.Automation.PropertyCondition($AE::IsControlElementProperty, $true)
$els = $win.FindAll($TS::Descendants, $cond)
$parts = New-Object System.Collections.ArrayList
foreach ($e in $els) {
  try {
    $ct = $e.Current.ControlType.ProgrammaticName
    if ($ct -match 'Edit|Document') {
      $vp = $null
      if ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$vp)) { $v=$vp.Current.Value; if ($v) { [void]$parts.Add($v) } }
      else { $tp=$null; if ($e.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern,[ref]$tp)) { $t=$tp.DocumentRange.GetText(20000); if ($t) { [void]$parts.Add($t) } } }
    }
  } catch {}
}
if ($parts.Count -eq 0) { foreach ($e in $els) { try { $n=$e.Current.Name; if ($n -and $e.Current.ControlType.ProgrammaticName -match 'Text') { [void]$parts.Add($n) } } catch {} } }
($parts -join "\`n")`;
  const text = await runPowerShell(ps, { wantStdout: true, timeout: 30000 });
  return { window: query || '(em foco)', text: String(text || '').slice(0, 20000) };
}

// ─── UIAutomation no macOS (Accessibility API via System Events / JXA) ───────
// Mesma ideia do Windows: acha elementos PELO NOME e clica/preenche/lê de
// verdade. Requer a permissão de Acessibilidade (o runJXA traduz o erro).
async function macUiaTree(query) {
  const jxa = `${MAC_UIA}
var KEEP=${JSON.stringify(MAC_KEEP_ROLES)}; var out=[];
function walk(e,d){ if(out.length>=120||d>14) return; var kids; try{kids=e.uiElements();}catch(_){return;}
 for(var i=0;i<kids.length;i++){ var c=kids[i];
  try{ var role=c.role(); var nm=elName(c);
   if(KEEP.indexOf(role)>=0 && nm){ var p,s; try{p=c.position();}catch(_){p=[0,0];} try{s=c.size();}catch(_){s=[0,0];}
    out.push({name:nm,type:role.replace('AX',''),x:Math.round(p[0]+s[0]/2),y:Math.round(p[1]+s[1]/2),enabled:true}); } }catch(_){}
  walk(c,d+1); if(out.length>=120) break; } }
var proc=getProc(${JSON.stringify(query || '')});
var wins; try{wins=proc.windows();}catch(_){wins=[];}
for(var w=0;w<wins.length;w++){ walk(wins[w],0); if(out.length>=120) break; }
JSON.stringify(out);`;
  const outStr = await runJXA(jxa);
  let arr = []; try { arr = JSON.parse(outStr || '[]'); } catch {}
  return { window: query || '(em foco)', count: arr.length, elements: arr };
}
async function macUiaClickElement(query, name) {
  if (!name) throw new Error('informe o name do elemento');
  const jxa = `${MAC_UIA}
var want=${JSON.stringify(name)}; var wl=want.toLowerCase(); var found=null;
function walk(e,d){ if(found||d>16) return; var kids; try{kids=e.uiElements();}catch(_){return;}
 for(var i=0;i<kids.length;i++){ var c=kids[i];
  try{ var nm=elName(c); if(nm && (nm===want || nm.toLowerCase().indexOf(wl)>=0)){ found=c; return; } }catch(_){}
  walk(c,d+1); if(found) return; } }
var proc=getProc(${JSON.stringify(query || '')});
var wins; try{wins=proc.windows();}catch(_){wins=[];}
for(var w=0;w<wins.length;w++){ walk(wins[w],0); if(found) break; }
if(!found) throw new Error('Elemento nao encontrado: '+want);
var R='';
try{ found.actions.byName('AXPress').perform(); R='OK:press:'+elName(found); }
catch(e){ var p,s; try{p=found.position();s=found.size();}catch(_2){throw new Error('Nao consegui clicar: '+e);}
  var cx=Math.round(p[0]+s[0]/2), cy=Math.round(p[1]+s[1]/2);
  Application('System Events').click(); R='OK:fallback:'+cx+','+cy; }
R;`;
  const out = await runJXA(jxa);
  return { ok: true, detail: String(out).trim() };
}
async function macUiaSetValue(query, name, text) {
  const jxa = `${MAC_UIA}
var want=${JSON.stringify(name || '')}; var txt=${JSON.stringify(text || '')}; var wl=want.toLowerCase(); var found=null;
function isField(r){ return r==='AXTextField'||r==='AXTextArea'||r==='AXComboBox'; }
function walk(e,d){ if(found||d>16) return; var kids; try{kids=e.uiElements();}catch(_){return;}
 for(var i=0;i<kids.length;i++){ var c=kids[i];
  try{ var role=c.role(); var nm=elName(c);
   if(isField(role) && (!want || nm===want || nm.toLowerCase().indexOf(wl)>=0)){ found=c; return; } }catch(_){}
  walk(c,d+1); if(found) return; } }
var proc=getProc(${JSON.stringify(query || '')});
var wins; try{wins=proc.windows();}catch(_){wins=[];}
for(var w=0;w<wins.length;w++){ walk(wins[w],0); if(found) break; }
if(!found) throw new Error('Campo nao encontrado: '+want);
var R='';
try{ found.value = txt; R='OK:setvalue:'+elName(found); }
catch(e){ try{ found.focused = true; }catch(_){}
  var se=Application('System Events'); se.keystroke('a',{using:'command down'}); se.keystroke(txt); R='OK:typed:'+elName(found); }
R;`;
  const out = await runJXA(jxa);
  return { ok: true, detail: String(out).trim() };
}
async function macUiaGetText(query) {
  const jxa = `${MAC_UIA}
var parts=[];
function grab(e,d){ if(parts.length>=60||d>16) return; var kids; try{kids=e.uiElements();}catch(_){return;}
 for(var i=0;i<kids.length;i++){ var c=kids[i];
  try{ var role=c.role();
   if(role==='AXTextArea'||role==='AXTextField'){ var v=c.value(); if(typeof v==='string'&&v) parts.push(v); }
   else if(role==='AXStaticText'){ var t=elName(c); if(t) parts.push(t); } }catch(_){}
  grab(c,d+1); } }
var proc=getProc(${JSON.stringify(query || '')});
var wins; try{wins=proc.windows();}catch(_){wins=[];}
for(var w=0;w<wins.length;w++){ grab(wins[w],0); }
parts.join('\\n');`;
  const text = await runJXA(jxa);
  return { window: query || '(em foco)', text: String(text || '').slice(0, 20000) };
}

async function run(op, args = {}) {
  switch (op) {
    case 'screenshot': return await screenshot();
    case 'open': return await openApp(args.target || args.app || args.url || args.path);
    case 'list_windows': return await listWindows();
    case 'focus': return await focusWindow(args.target || args.title || args.app || args.query);
    case 'uia_tree': return await uiaTree(args.window || args.target || '');
    case 'click_element': return await uiaClickElement(args.window || args.target || '', args.name);
    case 'set_value': return await uiaSetValue(args.window || args.target || '', args.name || '', args.text || '');
    case 'get_text': return await uiaGetText(args.window || args.target || '');
    case 'click': return await click(args.x, args.y, args.button);
    case 'type': return await type(args.text);
    case 'key': return await key(args.key || args.combo);
    default: throw new Error('op desconhecida: ' + op);
  }
}

module.exports = { run, screenshot, openApp, listWindows, focusWindow, uiaTree, uiaClickElement, uiaSetValue, uiaGetText, click, type, key };
