const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('djooNative', {
  platform: process.platform,
  discoverLibraries: () => ipcRenderer.invoke('djoo:discover-libraries'),
  scanLibrary: (request) => ipcRenderer.invoke('djoo:scan-library', request),
  getLibrarySyncStatus: (request) => ipcRenderer.invoke('djoo:get-library-sync-status', request),
  chooseLibraryFolder: (format) => ipcRenderer.invoke('djoo:choose-library-folder', format),
  loadLibraryState: () => ipcRenderer.invoke('djoo:load-library-state'),
  saveLibraryState: (state) => ipcRenderer.invoke('djoo:save-library-state', state),
  getCoverArt: (filePath) => ipcRenderer.invoke('djoo:get-cover-art', filePath),
  suggestPathFixes: (tracks) => ipcRenderer.invoke('djoo:suggest-path-fixes', tracks),
  relocateTrackFile: (track) => ipcRenderer.invoke('djoo:relocate-track-file', track),
  relocateMissingTracks: (tracks) => ipcRenderer.invoke('djoo:relocate-missing-tracks', tracks),
  commitSync: (request) => ipcRenderer.invoke('djoo:commit-sync', request)
});
