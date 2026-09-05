import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { safeFinalReply } from './privacy.mjs';
import { attachControl, childEnvironmentWithoutSecret, closeControl, readBoundedProcessText, spawnRuntime, validateInstruction, waitForExit } from './runner-common.mjs';

const POWERSHELL_BRIDGE = [
  "$ErrorActionPreference='Stop'",
  "$spec=Get-Content -Raw -Encoding UTF8 -LiteralPath $env:SHENLAN_IDE_LAUNCH_SPEC|ConvertFrom-Json",
  "Set-Location -LiteralPath ([string]$spec.cwd)",
  "$argv=@($spec.arguments|ForEach-Object{[string]$_})",
  "& ([string]$spec.executable) @argv",
  'exit $LASTEXITCODE'
].join(';');

const TRAE_UI_BRIDGE = String.raw`
$ErrorActionPreference='Stop'
$spec=Get-Content -Raw -Encoding UTF8 -LiteralPath $env:SHENLAN_TRAE_UI_SPEC|ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class ShenlanTraeUi {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION U; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk,wScan; public uint dwFlags,time; public UIntPtr dwExtraInfo; }
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd,int nCmdShow);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd,out RECT rect);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags,uint dx,uint dy,uint data,UIntPtr extra);
  [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,INPUT[] inputs,int size);
  static void Key(ushort vk,bool up=false){ var input=new INPUT{type=1,U=new INPUTUNION{ki=new KEYBDINPUT{wVk=vk,dwFlags=up?2u:0u}}}; if(SendInput(1,new[]{input},Marshal.SizeOf(typeof(INPUT)))!=1) throw new InvalidOperationException("keyboard input failed"); }
  public static void Text(string value){ foreach(char c in value){ var down=new INPUT{type=1,U=new INPUTUNION{ki=new KEYBDINPUT{wScan=c,dwFlags=4}}}; var up=down; up.U.ki.dwFlags=6; if(SendInput(2,new[]{down,up},Marshal.SizeOf(typeof(INPUT)))!=2) throw new InvalidOperationException("unicode input failed"); } }
  public static void Enter(){Key(0x0D);Key(0x0D,true);}
  public static void SelectAllAndClear(){Key(0x11);Key(0x41);Key(0x41,true);Key(0x11,true);Key(0x08);Key(0x08,true);}
  public static void Dispatch(string text){
    IntPtr handle=IntPtr.Zero;
    foreach(var process in Process.GetProcessesByName("Trae CN")){if(process.MainWindowHandle!=IntPtr.Zero){handle=process.MainWindowHandle;break;}}
    if(handle==IntPtr.Zero) throw new InvalidOperationException("TRAE window unavailable");
    ShowWindow(handle,9); if(!SetForegroundWindow(handle)) throw new InvalidOperationException("TRAE window cannot be activated");
    System.Threading.Thread.Sleep(700); RECT rect; if(!GetWindowRect(handle,out rect)) throw new InvalidOperationException("TRAE window bounds unavailable");
    int width=rect.Right-rect.Left,height=rect.Bottom-rect.Top;
    SetCursorPos(rect.Right-Math.Max(260,(int)(width*0.18)),rect.Bottom-Math.Max(95,(int)(height*0.11)));
    mouse_event(2,0,0,0,UIntPtr.Zero);mouse_event(4,0,0,0,UIntPtr.Zero);System.Threading.Thread.Sleep(500);
    SelectAllAndClear();Text("@");System.Threading.Thread.Sleep(700);Text("shenlan-remote");System.Threading.Thread.Sleep(900);Enter();System.Threading.Thread.Sleep(500);Text(text);System.Threading.Thread.Sleep(300);Enter();
  }
}
'@
[ShenlanTraeUi]::Dispatch([string]$spec.prompt)
`;

function promptFor(adapterCode, instruction, taskToken) {
  const name = adapterCode === 'trae' ? 'TRAE' : 'CodeBuddy';
  return [
    `这是从深蓝远程办公网页送达的 ${name} 任务。请在当前项目中亲自完成，不要只给计划。`,
    `本次回传标识：${taskToken}`,
    '处理过程中可调用 MCP 工具 shenlan_remote_progress 回传简短进度。',
    '完成后必须调用 shenlan_remote_complete，参数 taskToken 使用上面的标识，reply 填写给用户看的完整最终回答。',
    '若确实无法完成，调用 shenlan_remote_fail 回传脱敏原因。不要在普通聊天里声称已经回传。',
    '',
    instruction
  ].join('\n');
}

async function spawnIde(executable, argumentsList, cwd, outputDirectory, env) {
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)) {
    const base = path.dirname(path.dirname(path.resolve(executable)));
    const application = path.basename(executable).toLowerCase().startsWith('trae') ? 'Trae CN.exe' : 'CodeBuddy CN.exe';
    return { child: spawnRuntime(path.join(base, application), [path.join(base, 'resources', 'app', 'out', 'cli.js'), ...argumentsList], { cwd, env: { ...env, ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' } }), specPath: '' };
  }
  if (process.platform !== 'win32') return { child: spawnRuntime(executable, argumentsList, { cwd, env }), specPath: '' };
  await mkdir(outputDirectory, { recursive: true });
  const specPath = path.join(outputDirectory, `.ide-launch-${randomUUID()}.json`);
  await writeFile(specPath, JSON.stringify({ executable, arguments: argumentsList, cwd }), { encoding: 'utf8', mode: 0o600 });
  const encoded = Buffer.from(POWERSHELL_BRIDGE, 'utf16le').toString('base64');
  const child = spawnRuntime('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { cwd, env: { ...env, SHENLAN_IDE_LAUNCH_SPEC: specPath } });
  return { child, specPath };
}

async function spawnTraeUi(prompt, cwd, outputDirectory, env) {
  if (process.platform !== 'win32') throw new Error('TRAE 当前版本只在 Windows 提供经过验证的前台 Agent 桥接；其他系统请等待官方无头接口');
  await mkdir(outputDirectory, { recursive: true });
  const specPath = path.join(outputDirectory, `.trae-ui-${randomUUID()}.json`);
  await writeFile(specPath, JSON.stringify({ prompt }), { encoding: 'utf8', mode: 0o600 });
  const encoded = Buffer.from(TRAE_UI_BRIDGE, 'utf16le').toString('base64');
  const child = spawnRuntime('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    cwd, env: { ...env, SHENLAN_TRAE_UI_SPEC: specPath }
  });
  return { child, specPath };
}

async function waitForResult({ resultPath, progressPath, onProgress, control, timeoutMs }) {
  const started = Date.now();
  let progressStamp = '';
  while (Date.now() - started < timeoutMs) {
    if (control.cancelled) return { cancelled: true };
    const result = await readFile(resultPath, 'utf8').then(JSON.parse).catch(() => null);
    if (result) return result;
    const progress = await readFile(progressPath, 'utf8').then(JSON.parse).catch(() => null);
    if (progress && progress.updatedAt !== progressStamp) {
      progressStamp = progress.updatedAt;
      await onProgress({ summary: String(progress.summary || '智能体正在处理').slice(0, 240), progressPercent: Number(progress.progressPercent) || 50 });
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error('IDE 智能体未在限定时间内调用深蓝回传工具；请确认应用已打开、MCP 已启用且当前项目可用');
}

export async function runIdeAgentTask({ adapterCode, executable, executableArgs = [], project, instruction, resumeSessionId = '', interactionKeyEnv, outputDirectory, ideCallbackTimeoutMs = 30 * 60 * 1000, onProgress = async () => {}, control = {} }) {
  const taskToken = `${Date.now().toString(36)}_${randomBytes(18).toString('base64url')}`;
  const callbackDirectory = path.join(path.resolve(outputDirectory || os.tmpdir()), 'ide-callbacks');
  const resultPath = path.join(callbackDirectory, `${taskToken}.result.json`);
  const progressPath = path.join(callbackDirectory, `${taskToken}.progress.json`);
  await mkdir(callbackDirectory, { recursive: true, mode: 0o700 });
  await Promise.all([unlink(resultPath).catch(() => {}), unlink(progressPath).catch(() => {})]);
  const prompt = promptFor(adapterCode, validateInstruction(instruction), taskToken);
  const env = childEnvironmentWithoutSecret(interactionKeyEnv, { SHENLAN_IDE_CALLBACK_DIR: callbackDirectory });
  const opened = await spawnIde(executable, ['--reuse-window', project.path], project.path, outputDirectory || os.tmpdir(), env);
  const openExit = await waitForExit(opened.child);
  if (opened.specPath) await unlink(opened.specPath).catch(() => {});
  if (openExit.code !== 0) throw new Error(`${adapterCode === 'trae' ? 'TRAE' : 'CodeBuddy'} 无法打开授权项目`);
  await new Promise((resolve) => setTimeout(resolve, 1800));
  const panel = await spawnIde(executable, [...executableArgs, 'chat', '--mode', 'agent', '--maximize', '--reuse-window'], project.path, outputDirectory || os.tmpdir(), env);
  const panelExit = await waitForExit(panel.child);
  if (panel.specPath) await unlink(panel.specPath).catch(() => {});
  if (panelExit.code !== 0) throw new Error('TRAE 无法打开 Agent 面板');
  const launched = await spawnTraeUi(prompt, project.path, outputDirectory || os.tmpdir(), env);
  attachControl(control, launched.child);
  control.cancel = async () => { closeControl(control); };
  await onProgress({ summary: `${adapterCode === 'trae' ? 'TRAE' : 'CodeBuddy'} 已收到任务，等待本机智能体回传`, progressPercent: 30 });
  try {
    const [diagnostic, exit] = await Promise.all([readBoundedProcessText(launched.child.stderr), waitForExit(launched.child)]);
    if (exit.code !== 0) return { sessionId: resumeSessionId, finalReply: '', diagnostic, resumeSessionId, exitCode: exit.code, signal: exit.signal, cancelled: Boolean(control.cancelled) };
    const result = await waitForResult({ resultPath, progressPath, onProgress, control, timeoutMs: ideCallbackTimeoutMs });
    const sessionId = resumeSessionId || `${adapterCode}-${randomUUID()}`;
    if (result.cancelled) return { sessionId, finalReply: '', diagnostic, resumeSessionId, exitCode: 0, signal: '', cancelled: true };
    if (result.status !== 'completed') return { sessionId, finalReply: '', diagnostic: `${diagnostic}\n${result.message || 'TRAE 智能体回传失败'}`.trim(), resumeSessionId, exitCode: 1, signal: '', cancelled: false };
    return { sessionId, finalReply: safeFinalReply(result.reply), diagnostic, resumeSessionId, exitCode: 0, signal: '', cancelled: false };
  } finally {
    closeControl(control);
    if (launched.specPath) await unlink(launched.specPath).catch(() => {});
    await Promise.all([rm(resultPath, { force: true }).catch(() => {}), rm(progressPath, { force: true }).catch(() => {})]);
  }
}
