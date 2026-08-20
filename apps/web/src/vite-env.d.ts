/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MIS_LOGIN_URL: string;
  readonly VITE_SSO_CLIENT_ID: string;
  readonly VITE_MIS_HOME_URL?: string;
  readonly VITE_TASKMENTOR_HOME_URL?: string;
}
interface ImportMeta { readonly env: ImportMetaEnv }
