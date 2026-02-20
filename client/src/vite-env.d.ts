/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_NGROK: string
  // add other env variables here
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
