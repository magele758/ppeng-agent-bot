import { grokReplicaId } from './grok-history';

export interface GrokDirectory extends FileSystemDirectoryHandle {
  values(): AsyncIterable<FileSystemFileHandle | FileSystemDirectoryHandle>;
  queryPermission(options: {mode: 'read'}): Promise<PermissionState>;
}

type DirectoryPicker = (options: {mode: 'read'; id: string}) => Promise<GrokDirectory>;

export function directoryPicker(): DirectoryPicker | undefined {
  const browser = window as Window & { showDirectoryPicker?: DirectoryPicker };
  return browser.showDirectoryPicker?.bind(browser);
}

export async function replicaFiles(directory: GrokDirectory) {
  const files: File[] = [];
  for await (const handle of directory.values()) {
    if (handle.kind === 'file' && grokReplicaId(handle.name)) files.push(await handle.getFile());
  }
  return files;
}

/** Keep only the browser's read handle. The browser controls subsequent access. */
export function rememberedDirectory(save?: GrokDirectory): Promise<GrokDirectory | undefined> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('lab.grok-local-history', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('directories');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('directories', save ? 'readwrite' : 'readonly');
      const store = tx.objectStore('directories');
      const request = save ? store.put(save, 'source') : store.get('source');
      tx.oncomplete = () => { db.close(); resolve(save ?? request.result); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}
