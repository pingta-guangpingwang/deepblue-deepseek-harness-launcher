import { contextBridge, ipcRenderer } from 'electron'

interface PointerPosition {
  x: number
  y: number
}

contextBridge.exposeInMainWorld('desktopPetHost', {
  beginDrag: (position: PointerPosition) => ipcRenderer.send('desktop-pet:drag-start', position),
  moveDrag: (position: PointerPosition) => ipcRenderer.send('desktop-pet:drag-move', position),
  endDrag: (position: PointerPosition) => ipcRenderer.invoke('desktop-pet:drag-end', position)
})
