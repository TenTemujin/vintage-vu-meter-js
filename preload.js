
const { contextBridge, ipcRenderer } = require('electron');

console.log('✅ preload.js loaded');

contextBridge.exposeInMainWorld('electronAPI', {
    onSetSources: (callback) => {
        ipcRenderer.on('SET_SOURCES', (_, data) => {
            console.log('📡 SET_SOURCES:', data);
            callback(data);
        });
    },
    setAlwaysOnTop: (flag) => {
        ipcRenderer.send('SET_ALWAYS_ON_TOP', flag);
    }
});
