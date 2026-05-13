/// <reference types="vite/client" />

declare namespace React {
  interface InputHTMLAttributes<T> {
    webkitdirectory?: string | boolean;
    directory?: string | boolean;
  }
}
