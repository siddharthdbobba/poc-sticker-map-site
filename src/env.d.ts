/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_STICKER_CSV_URL?: string;
  readonly PUBLIC_STICKER_FORM_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
