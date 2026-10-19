import type { VinylApi } from './index'

declare global {
  interface Window {
    vinyl: VinylApi
  }
}

export {}
