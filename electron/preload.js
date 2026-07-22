const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Empty for now. Add IPC bridges here if we need to call node features from React.
});
