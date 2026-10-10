const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('buddy', Object.freeze({
  getState: () => ipcRenderer.invoke('buddy:get-state'),
  command: command => ipcRenderer.invoke('buddy:command', command),
  onState: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('buddy:state', listener);
    return () => ipcRenderer.removeListener('buddy:state', listener);
  },
  onCursor: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, position) => {
      if (!position || typeof position !== 'object' || Array.isArray(position)
          || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return;
      callback({ x: position.x, y: position.y });
    };
    ipcRenderer.on('buddy:cursor', listener);
    return () => ipcRenderer.removeListener('buddy:cursor', listener);
  },
  openPanel: () => ipcRenderer.invoke('buddy:open-panel'),
  setPetVisible: visible => ipcRenderer.invoke('buddy:set-pet-visible', visible),
  getPetPosition: () => ipcRenderer.invoke('buddy:get-pet-position'),
  movePet: position => ipcRenderer.invoke('buddy:move-pet', position),
  hidePanel: () => ipcRenderer.invoke('buddy:hide-panel'),
  quit: () => ipcRenderer.invoke('buddy:quit'),
  importFont: () => ipcRenderer.invoke('buddy:import-font'),
  confirmFontImport: pendingId => ipcRenderer.invoke('buddy:confirm-font-import', pendingId),
  cancelFontImport: pendingId => ipcRenderer.invoke('buddy:cancel-font-import', pendingId),
  getActiveFont: () => ipcRenderer.invoke('buddy:get-active-font'),
  resetPetPosition: () => ipcRenderer.invoke('buddy:reset-pet-position'),
  getAiConfig: () => ipcRenderer.invoke('buddy:ai', 'getAiConfig'),
  saveAiProfile: value => ipcRenderer.invoke('buddy:ai', 'saveAiProfile', value),
  testAiConnection: value => ipcRenderer.invoke('buddy:ai', 'testAiConnection', value),
  listAiModels: value => ipcRenderer.invoke('buddy:ai', 'listAiModels', value),
  listChats: () => ipcRenderer.invoke('buddy:ai', 'listChats'),
  createChat: value => ipcRenderer.invoke('buddy:ai', 'createChat', value),
  getChat: value => ipcRenderer.invoke('buddy:ai', 'getChat', value),
  archiveChat: value => ipcRenderer.invoke('buddy:ai', 'archiveChat', value),
  sendChat: value => ipcRenderer.invoke('buddy:ai', 'sendChat', value),
  stopChat: value => ipcRenderer.invoke('buddy:ai', 'stopChat', value),
  decomposeTask: value => ipcRenderer.invoke('buddy:ai', 'decomposeTask', value),
  onAiEvent: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('buddy:ai-event', listener);
    return () => ipcRenderer.removeListener('buddy:ai-event', listener);
  },
  getStudyConfig: () => ipcRenderer.invoke('buddy:study', 'getStudyConfig'),
  saveStudyConfig: value => ipcRenderer.invoke('buddy:study', 'saveStudyConfig', value),
  getStudyState: () => ipcRenderer.invoke('buddy:study', 'getStudyState'),
  connectStudy: value => ipcRenderer.invoke('buddy:study', 'connectStudy', value),
  studyCommand: value => ipcRenderer.invoke('buddy:study', 'studyCommand', value),
  leaveStudy: () => ipcRenderer.invoke('buddy:study', 'leaveStudy'),
  onStudyState: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('buddy:study-state', listener);
    return () => ipcRenderer.removeListener('buddy:study-state', listener);
  }
}));
