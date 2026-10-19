import { SshFactoryTransport } from "./transport.js";

/**
 * Fixed Python program. Lists absolute git checkout paths.
 * Probe stays identity-only. This op sits beside snapshot, count-files, and read-log.
 * No shell. Roots arrive as JSON. One path does not write factory settings.
 */
export const GIT_DISCOVERY_WORKER = String.raw`
import os, sys, json, pathlib, stat
req=json.load(sys.stdin)
if req.get('action')!='list-checkouts':
    raise SystemExit(1)
SENSITIVE={'.ssh','.gnupg','.aws','.kube','.docker'}
KEY_NAMES={'id_rsa','id_ed25519','id_ecdsa','id_dsa'}
def sensitive(part):
    low=part.lower()
    return low in SENSITIVE or low in KEY_NAMES or low.endswith('.pem') or low.endswith('.key')
def bad_path(text):
    if not isinstance(text,str) or len(text)>2048 or not text.startswith('/') or text.startswith('//') or '://' in text:
        return True
    if any(ord(ch)<32 or ord(ch)==127 for ch in text):
        return True
    parts=text.split('/')
    for i,part in enumerate(parts):
        if i>0 and part=='':
            return True
        if part in ('.','..') or sensitive(part):
            return True
    return False
def emit(paths, complete):
    print(json.dumps({'paths':paths,'complete':complete},ensure_ascii=False),flush=True)
raw=req['roots'] if 'roots' in req else None
if raw is None:
    bases=[pathlib.Path.home()]
else:
    if not isinstance(raw,list) or len(raw)>32:
        raise SystemExit(1)
    bases=[]
    for item in raw:
        if bad_path(item):
            raise SystemExit(1)
        bases.append(pathlib.Path(item))
found=[]
seen=set()
visited=0
complete=True
def prune(name):
    # Metadata and dependency/cache dirs. A checkout that is itself the root is still reported.
    return name in {'.git','node_modules','.cache','.npm','__pycache__'} or sensitive(name)
def looks_like_checkout(directory):
    git=directory/'.git'
    try:
        st=git.lstat()
    except OSError:
        return False
    if stat.S_ISLNK(st.st_mode):
        return False
    if stat.S_ISDIR(st.st_mode):
        head=git/'HEAD'
        try:
            if head.is_symlink():
                return False
            return head.is_file()
        except OSError:
            return False
    if stat.S_ISREG(st.st_mode):
        try:
            if st.st_size<=0 or st.st_size>4096:
                return False
            with git.open('r',encoding='utf-8',errors='replace') as fh:
                line=fh.readline(256)
            return line.startswith('gitdir:')
        except OSError:
            return False
    return False
def add(path, base_real):
    try:
        resolved=path.resolve()
    except OSError:
        return
    text=resolved.as_posix()
    if text in seen or bad_path(text) or not resolved.is_relative_to(base_real):
        return
    seen.add(text)
    found.append(text)
def onerror(_err):
    global complete
    complete=False
for base in bases:
    if len(found)>=100 or visited>20000:
        complete=False
        break
    try:
        if not base.is_dir():
            continue
        base_real=base.resolve()
    except OSError:
        continue
    if bad_path(base_real.as_posix()):
        raise SystemExit(1)
    base_depth=len(base.parts)
    for dirpath, dirnames, _filenames in os.walk(base, topdown=True, onerror=onerror, followlinks=False):
        visited+=1
        if visited>20000:
            complete=False
            dirnames[:]=[]
            break
        current=pathlib.Path(dirpath)
        if len(current.parts)-base_depth>16:
            complete=False
            dirnames[:]=[]
            continue
        kept=[]
        for name in dirnames:
            if prune(name):
                continue
            child=current/name
            try:
                if child.is_symlink():
                    if looks_like_checkout(child):
                        add(child, base_real)
                    continue
            except OSError:
                continue
            kept.append(name)
        dirnames[:]=kept
        if looks_like_checkout(current):
            add(current, base_real)
        if len(found)>=100:
            complete=False
            dirnames[:]=[]
            break
found.sort()
emit(found[:100], complete)
`;

const SENSITIVE_PARTS = new Set([".ssh", ".gnupg", ".aws", ".kube", ".docker"]);
const KEY_NAMES = new Set(["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"]);

function sensitivePart(part: string): boolean {
  const low = part.toLowerCase();
  return (
    SENSITIVE_PARTS.has(low) ||
    KEY_NAMES.has(low) ||
    low.endsWith(".pem") ||
    low.endsWith(".key")
  );
}

function unsafeCheckoutPath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0 || path.length > 2048) return true;
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("://")) return true;
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  const parts = path.split("/");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? "";
    if (i > 0 && part === "") return true;
    if (part === "." || part === "..") return true;
    if (sensitivePart(part)) return true;
  }
  return false;
}

function validateRoots(roots: string[]): void {
  if (!Array.isArray(roots) || roots.length > 32) throw new Error("Invalid checkout root");
  for (const root of roots) {
    if (unsafeCheckoutPath(root)) throw new Error("Invalid checkout root");
  }
}

function checkoutPaths(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid remote receipt");
  }
  if ((value as { complete?: unknown }).complete !== true) {
    throw new Error("Repository discovery was incomplete; specify a narrower root");
  }
  const paths = (value as { paths?: unknown }).paths;
  if (!Array.isArray(paths) || paths.length > 100) throw new Error("Invalid remote receipt");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    if (typeof path !== "string" || unsafeCheckoutPath(path) || seen.has(path)) {
      throw new Error("Invalid remote receipt");
    }
    seen.add(path);
    out.push(path);
  }
  return out;
}

/** Absolute git checkout paths on the SSH alias. Does not write factory settings. */
export async function listGitCheckouts(alias: string, roots?: string[]): Promise<string[]> {
  if (roots !== undefined) validateRoots(roots);
  const transport = new SshFactoryTransport();
  try {
    const value = await transport.runFixedPython(alias, GIT_DISCOVERY_WORKER, {
      action: "list-checkouts",
      ...(roots === undefined ? {} : { roots }),
    });
    return checkoutPaths(value);
  } finally {
    await transport.close();
  }
}
