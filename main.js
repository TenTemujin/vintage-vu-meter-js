
const { app, BrowserWindow, ipcMain, desktopCapturer } = require('electron');
const path = require('path');

let mainWindow;

app.whenReady().then(() => {
    mainWindow = new BrowserWindow({
        width: 500,
        height: 400,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
        },
    });

    mainWindow.loadFile('index.html');
    sendSources();

    ipcMain.on('SET_ALWAYS_ON_TOP', (_, flag) => {
        mainWindow.setAlwaysOnTop(flag);
    });
});

async function sendSources() {
    const sources = await desktopCapturer.getSources({ types: ['window', 'screen'] });
    const formatted = sources.map(src => ({ id: src.id, name: src.name }));
    mainWindow.webContents.send('SET_SOURCES', formatted);
}
