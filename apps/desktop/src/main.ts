import { app, BrowserWindow, Tray, Menu, shell, dialog } from 'electron';
import { type ChildProcess } from 'node:child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { pickPort } from './port-utils';
import { parseEnvContent, ensureEnvKey } from './env-utils';
import {
  electronNodeEnv,
  formatChildFailure,
  spawnElectronNode,
  waitForHttpOk,
  type SupervisedChild
} from './launch-utils';

// 统一 userData 目录名（否则会用 package.json 的 scoped 名 @ppeng/agent-desktop）
app.setName('agent-desktop');
if (process.platform === 'win32') {
  app.setAppUserModelId('dev.ppeng.agent');
}

interface StoreSchema {
  windowBounds: {
    width: number;
    height: number;
    x?: number;
    y?: number;
  };
  daemonPort: number;
  webPort: number;
}

/** 极简 JSON 文件配置存储（避免 electron-store v10 的 ESM/CJS 不兼容） */
class JsonStore {
  private filePath: string;
  private data: StoreSchema;
  constructor(defaults: StoreSchema) {
    this.filePath = path.join(app.getPath('userData'), 'config.json');
    this.data = { ...defaults };
    try {
      if (fs.existsSync(this.filePath)) {
        this.data = { ...defaults, ...JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) };
      }
    } catch {
      // 损坏的配置：回退到默认值
    }
  }
  get<K extends keyof StoreSchema>(key: K): StoreSchema[K] {
    return this.data[key];
  }
  set<K extends keyof StoreSchema>(key: K, value: StoreSchema[K]): void {
    this.data[key] = value;
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.error('[Store] Failed to persist config:', err);
    }
  }
}

// 默认端口与 Lab（daemon 37070 / Next 33815）保持一致，占用时自动探测递增
const DEFAULT_DAEMON_PORT = 37070;
const DEFAULT_WEB_PORT = 33815;
const PORT_PROBE_SPAN = 20;

let _store: JsonStore | null = null;
function getStore(): JsonStore {
  if (!_store) {
    _store = new JsonStore({
      windowBounds: { width: 1400, height: 900 },
      daemonPort: DEFAULT_DAEMON_PORT,
      webPort: DEFAULT_WEB_PORT
    });
  }
  return _store;
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let daemonProcess: ChildProcess | null = null;
let webProcess: ChildProcess | null = null;

// 当前实际生效的端口（探测后可能与 store 中的偏好值不同，探测结果会写回 store）
let currentDaemonPort = 0;
let currentWebPort = 0;

const isDev = !app.isPackaged;

// 获取资源路径
function getResourcePath(...segments: string[]): string {
  if (isDev) {
    return path.join(process.cwd(), '..', '..', ...segments);
  }
  return path.join(process.resourcesPath, ...segments);
}

// daemon 入口（开发时直接用 apps/daemon/dist，打包后用 server-bundle）
function getDaemonEntry(): string {
  if (isDev) {
    return path.join(process.cwd(), '..', 'daemon', 'dist', 'server.js');
  }
  return getResourcePath('server-bundle', 'apps', 'daemon', 'dist', 'server.js');
}

/** daemon `cwd()` is repoRoot — packaged Finder launches often have cwd `/`. */
function getDaemonCwd(): string {
  if (isDev) {
    return path.join(process.cwd(), '..', '..');
  }
  return getResourcePath('server-bundle');
}

function pipeChildLog(prefix: string, chunk: string): void {
  for (const line of chunk.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) console.log(prefix, trimmed);
  }
}

async function waitUntilHealthy(opts: {
  name: string;
  url: string;
  child: SupervisedChild;
  isAcceptable?: (status: number) => boolean;
}): Promise<void> {
  try {
    await waitForHttpOk({
      url: opts.url,
      maxAttempts: 30,
      intervalMs: 500,
      initialDelayMs: 400,
      requestTimeoutMs: 1000,
      isAcceptable: opts.isAcceptable,
      shouldAbort: () => opts.child.takeExitError(opts.url)
    });
  } catch (err) {
    const dead = opts.child.takeExitError(opts.url);
    if (dead) throw dead;
    if (err instanceof Error && err.message.startsWith('Health check timeout:')) {
      throw formatChildFailure({
        name: opts.name,
        url: opts.url,
        exitCode: null,
        logs: opts.child.logs()
      });
    }
    throw err;
  }
}

// web console 入口（standalone 产物）
function getWebEntry(): { entry: string; cwd: string } {
  if (isDev) {
    const cwd = path.join(process.cwd(), '..', 'web-console', '.next', 'standalone');
    return { entry: path.join(cwd, 'apps', 'web-console', 'server.js'), cwd };
  }
  const cwd = getResourcePath('web');
  return { entry: path.join(cwd, 'apps', 'web-console', 'server.js'), cwd };
}

// 获取状态目录
function getStateDir(): string {
  const stateDir = path.join(app.getPath('userData'), 'state');
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }
  return stateDir;
}

// 用户配置目录下的 .env 路径
function getUserEnvPath(): string {
  return path.join(app.getPath('userData'), '.env');
}

function readUserEnv(): Record<string, string> {
  const envPath = getUserEnvPath();
  if (!fs.existsSync(envPath)) return {};
  return parseEnvContent(fs.readFileSync(envPath, 'utf-8'));
}

/**
 * 探测 daemon / web 实际可用端口：优先用户 .env 中的显式端口，其次 store 中保存的偏好值，
 * 与 Lab 默认（37070 / 33815）一致；占用时递增探测，并把最终生效端口写回 store。
 */
async function resolvePorts(): Promise<{ daemonPort: number; webPort: number }> {
  const store = getStore();
  const userEnv = readUserEnv();

  const preferredDaemon = Number(userEnv.RAW_AGENT_DAEMON_PORT) || store.get('daemonPort');
  const preferredWeb = Number(userEnv.RAW_AGENT_WEB_PORT || userEnv.PORT) || store.get('webPort');

  const daemonPort = await pickPort(preferredDaemon, PORT_PROBE_SPAN);
  let webPort = await pickPort(preferredWeb, PORT_PROBE_SPAN);
  if (webPort === daemonPort) {
    webPort = await pickPort(daemonPort + 1, PORT_PROBE_SPAN);
  }

  if (daemonPort !== preferredDaemon) {
    console.warn(`[Main] daemon port ${preferredDaemon} busy, using ${daemonPort}`);
  }
  if (webPort !== preferredWeb) {
    console.warn(`[Main] web port ${preferredWeb} busy, using ${webPort}`);
  }

  // 无论是否变化，都写回 store，使其始终反映真实生效端口
  store.set('daemonPort', daemonPort);
  store.set('webPort', webPort);

  return { daemonPort, webPort };
}

/**
 * 确保 daemon 与 web 进程共用同一个鉴权 token：优先使用用户 .env 中已配置的值，
 * 若缺失则生成本地随机 token 并写回用户 .env，避免开启鉴权后 web 请求 daemon 401。
 */
function ensureAuthToken(): string {
  return ensureEnvKey(getUserEnvPath(), 'RAW_AGENT_AUTH_TOKEN', () => {
    console.log('[Main] No RAW_AGENT_AUTH_TOKEN found, generating one and saving to user .env');
    return crypto.randomBytes(24).toString('hex');
  });
}

// 启动 Daemon
async function startDaemon(port: number, authToken: string): Promise<void> {
  const daemonPath = getDaemonEntry();
  const daemonCwd = getDaemonCwd();
  const stateDir = getStateDir();

  if (!fs.existsSync(daemonPath)) {
    throw new Error(`Daemon entry not found: ${daemonPath}`);
  }

  console.log('[Daemon] Starting daemon from:', daemonPath);
  console.log('[Daemon] cwd:', daemonCwd);
  console.log('[Daemon] State directory:', stateDir);

  // 用户 .env 先合并，再用实际探测端口 / token 强制覆盖，确保监听端口与健康检查一致
  const env = electronNodeEnv(process.env, {
    ...readUserEnv(),
    RAW_AGENT_STATE_DIR: stateDir,
    RAW_AGENT_DAEMON_HOST: '127.0.0.1',
    RAW_AGENT_DAEMON_PORT: String(port),
    RAW_AGENT_AUTH_TOKEN: authToken,
    NODE_ENV: 'production'
  });

  const child = spawnElectronNode({
    execPath: process.execPath,
    script: daemonPath,
    cwd: daemonCwd,
    env,
    name: 'Daemon',
    onLog: (chunk) => pipeChildLog('[Daemon]', chunk)
  });
  daemonProcess = child.process;
  daemonProcess.on('exit', (code) => {
    console.log('[Daemon] Exited with code:', code);
    daemonProcess = null;
  });

  const url = `http://127.0.0.1:${port}/api/health`;
  await waitUntilHealthy({ name: 'Daemon', url, child });
  console.log('[Daemon] Health check OK');
}

// 启动 Web Console
async function startWebConsole(webPort: number, daemonPort: number, authToken: string): Promise<void> {
  const { entry: webPath, cwd: webCwd } = getWebEntry();

  if (!fs.existsSync(webPath)) {
    throw new Error(`Web console entry not found: ${webPath}`);
  }

  console.log('[Web] Starting web console from:', webPath);

  const env = electronNodeEnv(process.env, {
    PORT: String(webPort),
    DAEMON_PROXY_TARGET: `http://127.0.0.1:${daemonPort}`,
    RAW_AGENT_AUTH_TOKEN: authToken,
    NODE_ENV: 'production',
    HOSTNAME: '127.0.0.1'
  });

  const child = spawnElectronNode({
    execPath: process.execPath,
    script: webPath,
    cwd: webCwd,
    env,
    name: 'Web console',
    onLog: (chunk) => pipeChildLog('[Web]', chunk)
  });
  webProcess = child.process;
  webProcess.on('exit', (code) => {
    console.log('[Web] Exited with code:', code);
    webProcess = null;
  });

  const url = `http://127.0.0.1:${webPort}/`;
  await waitUntilHealthy({
    name: 'Web console',
    url,
    child,
    isAcceptable: (status) => status < 500
  });
  console.log('[Web] Server responding');
}

// 探测端口、准备鉴权 token，并依次启动 daemon 与 web console
async function startServices(): Promise<void> {
  const { daemonPort, webPort } = await resolvePorts();
  currentDaemonPort = daemonPort;
  currentWebPort = webPort;

  const authToken = ensureAuthToken();

  await startDaemon(daemonPort, authToken);
  await startWebConsole(webPort, daemonPort, authToken);
}

// 停止所有进程
function stopAllProcesses(): void {
  if (webProcess) {
    console.log('[Web] Stopping...');
    webProcess.kill();
    webProcess = null;
  }
  if (daemonProcess) {
    console.log('[Daemon] Stopping...');
    daemonProcess.kill();
    daemonProcess = null;
  }
}

// 创建主窗口
async function createWindow(): Promise<void> {
  const bounds = getStore().get('windowBounds');

  mainWindow = new BrowserWindow({
    ...bounds,
    title: 'Agent Home',
    minWidth: 1000,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js')
    },
    titleBarStyle: 'default',
    show: false
  });

  // 锁定窗口标题，避免网页 <title> 覆盖成 “Agent Lab · Debug Console” 之类
  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault();
  });

  // 保存窗口尺寸
  mainWindow.on('close', () => {
    if (mainWindow) {
      getStore().set('windowBounds', mainWindow.getBounds());
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 打开外部链接
  mainWindow.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  try {
    // 启动后端服务
    await startServices();

    // 加载 Web Console
    const webUrl = `http://127.0.0.1:${currentWebPort}`;
    console.log('[Main] Loading:', webUrl);
    await mainWindow.loadURL(webUrl);

    mainWindow.show();
  } catch (error) {
    console.error('[Main] Failed to start services:', error);
    dialog.showErrorBox(
      'Startup Failed',
      `Failed to start Raw Agent services:\n\n${error instanceof Error ? error.message : String(error)}`
    );
    app.quit();
  }
}

// 创建托盘图标
function createTray(): void {
  // 使用简单的模板图标（需要后续添加图标文件）
  const iconPath = path.join(__dirname, '../assets/trayTemplate.png');
  
  // 如果图标不存在，创建一个临时的
  if (!fs.existsSync(iconPath)) {
    console.log('[Tray] Icon not found, using default');
  }

  try {
    tray = new Tray(iconPath);
  } catch {
    // Fallback: 不创建托盘图标
    console.log('[Tray] Could not create tray icon');
    return;
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Raw Agent',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Open State Directory',
      click: () => {
        shell.openPath(getStateDir());
      }
    },
    {
      label: 'Open Config (.env)',
      click: () => {
        const envPath = getUserEnvPath();
        if (!fs.existsSync(envPath)) {
          const templatePath = getResourcePath('.env.example');
          if (fs.existsSync(templatePath)) {
            fs.copyFileSync(templatePath, envPath);
          } else {
            fs.writeFileSync(envPath, '# Raw Agent Configuration\n');
          }
        }
        shell.openPath(envPath);
      }
    },
    { type: 'separator' },
    {
      label: 'Restart Services',
      click: async () => {
        stopAllProcesses();
        if (mainWindow) {
          try {
            await startServices();
            await mainWindow.loadURL(`http://127.0.0.1:${currentWebPort}`);
          } catch (error) {
            console.error('[Tray] Restart failed:', error);
          }
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      }
    }
  ]);

  tray.setToolTip('Raw Agent');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
}

// App 生命周期
app.whenReady().then(async () => {
  console.log('[App] Ready, starting...');
  console.log('[App] User data:', app.getPath('userData'));
  console.log('[App] Is packaged:', app.isPackaged);

  createTray();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  console.log('[App] Quitting, stopping services...');
  stopAllProcesses();
});

app.on('will-quit', () => {
  stopAllProcesses();
});

// 处理未捕获的异常
process.on('uncaughtException', (error) => {
  console.error('[Process] Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled rejection:', reason);
});
